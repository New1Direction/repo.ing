import BN from 'bn.js'
import { Keypair, PACKET_DATA_SIZE, PublicKey, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DefinitiveLaunchError, sendLaunch } from './meteora-launch.mjs'
import { withVersionedLaunchPriorityFee } from './launch-wallet-fees.mjs'
import { lookupTableLoader, prepareVersionedLaunchSigning } from './early-access-launch.mjs'
import { BUNDLE_VAULT_PROGRAM_ID, DBC_EVENT_AUTHORITY, DBC_POOL_AUTHORITY, DBC_PROGRAM_ID, STATUS, bundleAddress, bundleBuyQuote,
  decodeBundle, decodePlatform, launchAmounts, platformAddress, releaseInstruction, routerAddress, settleInstruction, vaultAddress } from './bundle-vault.mjs'

// The Bundle launch (docs/BUNDLE_LAUNCH.md): one v0 transaction with the bundle lookup table holding, in order, the compute
// budget, the program's release (the raise, less operations, to the launch signer), DBC's pool creation on the bundle config with
// the launch signer's first swap of exactly the released SOL at top level and the vault as receiver (the only way the swap gets
// DBC's minimum fee), and the program's settle (the vault must hold every bought token). The launch signer is a server key
// (BUNDLE_LAUNCH_SIGNER_SECRET_KEY) and the transaction's payer, so the market's launcher wallet is that key. It has the other
// launchers' interface (prepare, restore, submit, inspect), so the coordinator drives it the same way.

const isBudget = ix => ix.programId.equals(ComputeBudgetProgram.programId)
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const SYSTEM = new PublicKey('11111111111111111111111111111111')
const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

export class BundleLaunchError extends Error {
  constructor(message) { super(message); this.name = 'BundleLaunchError' }
}

// The keys every bundle launch shares: what the bundle lookup table must hold.
export function bundleLaunchLookupAddresses(config, opsWallet, programId = BUNDLE_VAULT_PROGRAM_ID) {
  return [DBC_POOL_AUTHORITY, DBC_EVENT_AUTHORITY, DBC_PROGRAM_ID, TOKEN_PROGRAM_ID, SYSTEM, INSTRUCTIONS_SYSVAR, NATIVE_MINT,
    new PublicKey(programId), new PublicKey(config), ATA_PROGRAM, METAPLEX, ComputeBudgetProgram.programId, platformAddress(programId),
    new PublicKey(opsWallet)]
}

// The bundle config as the program and the site need it: its fees go to the router, in SOL only, on SPL mints with a SOL quote,
// and its leftover (the builder allocation's source) goes to the creator signer.
export async function readBundleConfig(dbc, config, { creator, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const fixed = await dbc.state.getPoolConfig(config)
  if (!fixed || !fixed.feeClaimer.equals(routerAddress(programId)) || !fixed.quoteMint.equals(NATIVE_MINT) || Number(fixed.collectFeeMode) !== 0 ||
    Number(fixed.tokenType) !== 0 || !fixed.leftoverReceiver.equals(new PublicKey(creator))) {
    throw new BundleLaunchError('The bundle config is missing or is not the one Bundle launches need.')
  }
  return fixed
}

// config: BUNDLE_DBC_CONFIG; lookupTable: BUNDLE_LOOKUP_TABLE; creator: the platform creator signer (pool creator and the bundle
// program's admin); launchSigner: the bundle launch signer (payer, first buyer, the program's launch signer).
export function createBundleLauncher({ connection, config, creator, launchSigner, lookupTable = null, metadataOrigin = null,
  programId = BUNDLE_VAULT_PROGRAM_ID, now = Date.now }) {
  const configKey = new PublicKey(config), program = new PublicKey(programId)
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const loadLookupTables = lookupTableLoader(connection)

  async function readSetup(id) {
    if (!lookupTable) throw new BundleLaunchError('Bundle launches are not configured.')
    const [fixed, platformInfo, bundleInfo, table] = await Promise.all([
      readBundleConfig(client, configKey, { creator: creator.publicKey, programId: program }),
      connection.getAccountInfo(platformAddress(program), 'confirmed'),
      connection.getAccountInfo(bundleAddress(id, program), 'confirmed'),
      connection.getAddressLookupTable(new PublicKey(lookupTable), { commitment: 'confirmed' }).then(result => result.value),
    ])
    let platform = null, bundle = null
    try { platform = platformInfo?.owner.equals(program) ? decodePlatform(platformInfo.data) : null } catch {}
    try { bundle = bundleInfo?.owner.equals(program) ? decodeBundle(bundleInfo.data) : null } catch {}
    if (!platform || !platform.admin.equals(creator.publicKey) || !platform.launchSigner.equals(launchSigner.publicKey) ||
      !platform.curveConfig.equals(configKey)) throw new BundleLaunchError('Bundle launches are not set up on Solana yet.')
    if (!bundle) throw new BundleLaunchError('This bundle does not exist on Solana.')
    if (bundle.status !== STATUS.RAISING || bundle.released !== 0n) throw new BundleLaunchError('This bundle is not waiting for its launch.')
    if (bundle.raised !== bundle.target) throw new BundleLaunchError('This bundle\'s raise is not full yet.')
    if (Math.floor(now() / 1000) > bundle.deadline + bundle.launchGraceSecs) throw new BundleLaunchError('This bundle\'s launch time has passed; its backers can take their SOL back.')
    if (!bundle.curveConfig.equals(configKey)) throw new BundleLaunchError('This bundle was opened for another config.')
    const shared = new Set(table?.state.addresses.map(address => address.toBase58()) ?? [])
    if (!table?.isActive() || !bundleLaunchLookupAddresses(configKey, platform.opsWallet, program).every(address => shared.has(address.toBase58()))) {
      throw new BundleLaunchError('The bundle lookup table is missing or incomplete.')
    }
    return { fixed, platform, bundle, table }
  }

  return {
    creatorWallet: creator.publicKey.toBase58(),
    // launcherWallet must be the launch signer; bundle: { id } — the bundle whose full raise this launch spends.
    async prepare({ launcherWallet, tokenName, tokenSymbol, bundle: request }) {
      const signer = new PublicKey(launcherWallet)
      if (!signer.equals(launchSigner.publicKey)) throw new Error('A bundle launch is paid and signed by the bundle launch signer')
      if (!request || !/^[1-9]\d{0,17}$/.test(String(request.id))) throw new Error('Bundle launch needs its bundle id')
      const id = BigInt(request.id)
      const { fixed, platform, bundle, table } = await readSetup(id)
      const { ops, buy } = launchAmounts(bundle.raised, bundle.opsBps)
      const minimumTokens = bundleBuyQuote(client, fixed, buy)
      const mint = Keypair.generate()
      const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, configKey)
      const created = await client.creator.createPoolWithFirstBuy({
        createPoolParam: { baseMint: mint.publicKey, config: configKey, name: tokenName, symbol: tokenSymbol,
          uri: metadataOrigin ? `${metadataOrigin}/api/token-metadata/${mint.publicKey.toBase58()}` : '', payer: signer, poolCreator: creator.publicKey },
        firstBuyParam: { buyer: signer, receiver: vaultAddress(bundleAddress(id, program), program), buyAmount: new BN(buy.toString()),
          minimumAmountOut: new BN(minimumTokens.toString()), referralTokenAccount: null } })
      // The SDK's own compute budget instructions are dropped: the launch sets its budget exactly once (duplicates fail).
      const instructions = [releaseInstruction({ launchSigner: signer, opsWallet: platform.opsWallet, id, programId: program }),
        ...created.instructions.filter(ix => !isBudget(ix)),
        settleInstruction({ launchSigner: signer, id, pool, mint: mint.publicKey, minTokens: minimumTokens, programId: program })]
      const latest = await connection.getLatestBlockhash('confirmed')
      const { transaction: tx, ...landing } = await withVersionedLaunchPriorityFee(connection, instructions,
        { feePayer: signer, blockhash: latest.blockhash, lookupTables: [table] })
      const size = tx.serialize().length
      if (size > PACKET_DATA_SIZE) {
        console.warn('bundle_launch_too_large', { bytes: size })
        throw new BundleLaunchError('This bundle launch does not fit in one Solana transaction. Use a shorter token name or ticker.')
      }
      return {
        mint: mint.publicKey.toBase58(), pool: pool.toBase58(), initialBuyOutput: minimumTokens.toString(),
        blockhash: latest.blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        priorityFee: { computeUnitLimit: landing.computeUnitLimit, microLamports: landing.microLamports, lamports: landing.priorityFeeLamports.toString() },
        bundle: { id: id.toString(), raised: bundle.raised.toString(), ops: ops.toString(), buy: buy.toString() },
        transaction: tx, mintSecretKey: mint.secretKey,
        sign: prepareVersionedLaunchSigning(tx, signer, creator, mint, loadLookupTables),
      }
    },
    restore({ transaction, mintSecretKey, mint, launcherWallet, blockhash, lastValidBlockHeight }) {
      let tx
      try { tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64')) } catch { tx = null }
      const signer = new PublicKey(launcherWallet)
      const mintKeypair = Keypair.fromSecretKey(mintSecretKey)
      if (mintKeypair.publicKey.toBase58() !== mint) throw new DefinitiveLaunchError('Prepared launch mint does not match its key')
      if (!signer.equals(launchSigner.publicKey) || tx?.version !== 0 || !tx.message.staticAccountKeys[0]?.equals(signer) ||
        tx.message.recentBlockhash !== blockhash) throw new DefinitiveLaunchError('Prepared launch transaction does not match its review')
      return { mint, blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight), sign: prepareVersionedLaunchSigning(tx, signer, creator, mintKeypair, loadLookupTables) }
    },
    // The launch signer signs what this launcher prepared; the coordinator's signTransaction callback for a bundle launch.
    signAsLaunchSigner: async tx => { tx.sign([launchSigner]); return tx },
    submit: launch => sendLaunch(connection, launch),
    // Landed: the signature confirmed, the pool on the bundle config by our creator for this mint, an SPL mint, and the bundle
    // launched into this pool.
    async inspect({ mint, pool, launchSignature, bundleId }) {
      const status = (await connection.getSignatureStatuses([launchSignature], { searchTransactionHistory: true })).value[0]
      if (!status || status.err || !['confirmed', 'finalized'].includes(status.confirmationStatus)) return false
      const [state, mintInfo, bundleInfo] = await Promise.all([client.state.getPool(pool), connection.getAccountInfo(new PublicKey(mint), 'confirmed'),
        bundleId === undefined || bundleId === null ? null : connection.getAccountInfo(bundleAddress(bundleId, program), 'confirmed')])
      let bundle = null
      try { bundle = bundleInfo?.owner.equals(program) ? decodeBundle(bundleInfo.data) : null } catch {}
      return Boolean(state && mintInfo?.owner.equals(TOKEN_PROGRAM_ID) && state.poolState.config.equals(configKey) &&
        state.poolState.creator.equals(creator.publicKey) && state.poolState.baseMint.equals(new PublicKey(mint)) &&
        (bundleId === undefined || bundleId === null || (bundle?.status === STATUS.LAUNCHED && bundle.pool.equals(new PublicKey(pool)))))
    },
  }
}
