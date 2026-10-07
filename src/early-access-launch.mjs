import bs58 from 'bs58'
import BN from 'bn.js'
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { ComputeBudgetProgram, Keypair, PACKET_DATA_SIZE, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { AccountsType, ActivationType, DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DefinitiveLaunchError, sendLaunch } from './meteora-launch.mjs'
import { launchBuyQuote } from './launch-buy.mjs'
import { withVersionedLaunchPriorityFee } from './launch-wallet-fees.mjs'
import { matchesReviewedVersionedLaunch } from './launch-wallet-assertions.mjs'
import { readChainPoint } from './chain-clock.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID, MAX_EARLY_ACCESS_SECONDS, RULES, dbcBaseVault, decodePlatform, initMintInstruction, platformAddress,
  removeWalletsInstruction, transferHookAccounts } from './early-access-hook.mjs'
import { EARLY_ACCESS_FEE_CLAIMER, earlyAccessLookupAddresses, readEarlyAccessConfig } from './early-access-config.mjs'
import { earlyAccessWindow } from './early-access.mjs'
import { FAIR_RAMP, HOOK_RULE_SETS, firstBuyCapBaseUnits, hasFairRamp, hasStarUnlocks, rampSettings } from './early-access-rules.mjs'

// The contributor early access launch (docs/EARLY_ACCESS.md): one v0 transaction with the early access lookup table, holding,
// in order, the compute budget, the hook's init_mint (the launcher listed only when it buys), DBC's pool creation on the early
// access config (with the launcher's first buy, if any, through the hook), and the launcher's removal from the list unless the
// launcher's wallet is linked to one of the repository's contributors. It has the legacy launcher's interface (prepare, restore,
// submit, inspect), so the coordinator, the persisted review and the launch API drive it the same way.

// The program refuses a window ending more than 24 hours after the chain's clock. The end is measured from wall time (what the
// launcher chose), but never closer than this to that cap by the chain's clock, which may lag wall time or move on before the
// transaction lands.
export const EARLY_ACCESS_CHAIN_MARGIN_SECONDS = 5 * 60
// The window must still be open by at least this much when it is set (chain time), or the prepare is refused.
const MIN_OPEN_SECONDS = 60
const isBudget = ix => ix.programId.equals(ComputeBudgetProgram.programId)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export class EarlyAccessLaunchError extends Error {
  constructor(message) { super(message); this.name = 'EarlyAccessLaunchError' }
}

// The window end (unix seconds) for a launch prepared now: wallNow + the chosen window, capped by chain time as above.
export function earlyAccessEnd({ windowSeconds, wallNow, chainNow }) {
  const window = earlyAccessWindow(windowSeconds)
  if (![wallNow, chainNow].every(Number.isSafeInteger)) throw new EarlyAccessLaunchError('Solana\'s clock is unavailable. Try again shortly.')
  const end = Math.min(wallNow + window, chainNow + MAX_EARLY_ACCESS_SECONDS - EARLY_ACCESS_CHAIN_MARGIN_SECONDS)
  if (end < chainNow + MIN_OPEN_SECONDS) throw new EarlyAccessLaunchError('Solana\'s clock is too far from ours to set the early access window. Try again shortly.')
  return end
}

export function validEd25519Signature(publicKey, message, signature) {
  if (!signature || signature.length !== 64 || signature.every(byte => byte === 0)) return false
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(publicKey).toBuffer()]), format: 'der', type: 'spki' })
  return verifySignature(null, Buffer.from(message), key, Buffer.from(signature))
}

// The lookup tables a v0 message names, read from chain (only needed when a wallet appended safety assertions).
export const lookupTableLoader = connection => async message => Promise.all(message.addressTableLookups.map(async lookup => {
  const table = (await connection.getAddressLookupTable(lookup.accountKey, { commitment: 'confirmed' })).value
  if (!table) throw Error('Launch lookup table is missing')
  return table
}))

export const UNREADABLE_SIGNED_LAUNCH = 'Your wallet returned a transaction this launch cannot read. Refresh this page and review the launch again.'

// The signed v0 launch the page posts back (base64). Anything else (missing, malformed, a legacy transaction) is refused with a
// message the page can show; nothing has been sent.
export function readSignedVersionedLaunch(base64) {
  let tx = null
  try { if (typeof base64 === 'string') tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64')) } catch {}
  if (tx?.version !== 0) throw new DefinitiveLaunchError(UNREADABLE_SIGNED_LAUNCH)
  return tx
}

// As prepareLaunchSigning (src/meteora-launch.mjs) for the v0 launch: the wallet receives it before the creator and mint sign;
// only the reviewed message, or it with trailing Lighthouse assertions, is co-signed.
export function prepareVersionedLaunchSigning(tx, launcher, creator, mint, loadLookupTables) {
  const reviewed = Buffer.from(tx.message.serialize())
  return async signTransaction => {
    const signed = await signTransaction(tx)
    if (!(signed instanceof VersionedTransaction) || signed.version !== 0 || !Array.isArray(signed.signatures)) {
      throw new DefinitiveLaunchError(UNREADABLE_SIGNED_LAUNCH)
    }
    const payerMatches = signed.message.staticAccountKeys[0]?.equals(launcher) === true
    if (!payerMatches || !await matchesReviewedVersionedLaunch(reviewed, signed, loadLookupTables)) {
      console.warn('launch_wallet_message_changed', {
        validTransaction: signed instanceof VersionedTransaction, version: signed?.version ?? null,
        blockhashChanged: signed?.message?.recentBlockhash !== tx.message.recentBlockhash, payerChanged: !payerMatches,
      })
      throw new DefinitiveLaunchError('Your wallet changed the launch transaction. Refresh this page and review the launch again.')
    }
    // Verify the user's signature over the whole returned message, assertions included.
    const message = signed.message.serialize()
    if (!validEd25519Signature(launcher, message, signed.signatures[0])) throw new DefinitiveLaunchError('Launcher signature missing or invalid')
    signed.sign([creator, mint])
    const signers = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures)
    if (!signers.every((signer, i) => validEd25519Signature(signer, message, signed.signatures[i]))) {
      throw new DefinitiveLaunchError('Launch signatures are incomplete or invalid')
    }
    return { raw: Buffer.from(signed.serialize()), signature: bs58.encode(signed.signatures[0]) }
  }
}

// The token's metadata link: the short form by repository id (app/m/[id]/route.js), about 50 bytes shorter than
// /api/token-metadata/<mint> (a mint is 44 characters, a GitHub repository id 10 digits or fewer). The launch is one
// transaction under Solana's 1,232 bytes, and the fair ramp's settings take 32 of them. No origin (tests and local runs): no link.
export const earlyAccessMetadataUri = (origin, repoId) => origin ? `${origin}/m/${repoId}` : ''

// config: EARLY_ACCESS_DBC_CONFIG; lookupTable: EARLY_ACCESS_LOOKUP_TABLE (needed to prepare; a restored review names its own).
// feeClaimer: the partner wallet the config must name (tests pass their own).
export function createEarlyAccessLauncher({ connection, config, creator, lookupTable = null, metadataOrigin = null,
  hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID, feeClaimer = EARLY_ACCESS_FEE_CLAIMER, now = Date.now }) {
  const configKey = new PublicKey(config), hook = new PublicKey(hookProgram)
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const loadLookupTables = lookupTableLoader(connection)

  // The platform (its admin must be the launch co-signer, or init_mint fails) and the lookup table (every shared key, active).
  async function readSetup() {
    if (!lookupTable) throw new EarlyAccessLaunchError('Early access launches are not configured.')
    const [decoded, platformInfo, table, clock] = await Promise.all([
      readEarlyAccessConfig(connection, configKey, { leftoverReceiver: creator.publicKey, feeClaimer, hookProgram: hook }),
      connection.getAccountInfo(platformAddress(hook), 'confirmed'),
      connection.getAddressLookupTable(new PublicKey(lookupTable), { commitment: 'confirmed' }).then(result => result.value),
      readChainPoint(connection, ActivationType.Timestamp),
    ])
    let platform = null
    try { platform = platformInfo?.owner.equals(hook) ? decodePlatform(platformInfo.data) : null } catch {}
    if (!platform?.admin.equals(creator.publicKey)) throw new EarlyAccessLaunchError('Early access is not set up on Solana yet.')
    const shared = new Set(table?.state.addresses.map(address => address.toBase58()) ?? [])
    if (!table?.isActive() || !earlyAccessLookupAddresses(configKey, hook).every(address => shared.has(address.toBase58()))) {
      throw new EarlyAccessLaunchError('The early access lookup table is missing or incomplete.')
    }
    return { fixed: decoded.config, table, chainNow: Number(clock.toString()) }
  }

  return {
    creatorWallet: creator.publicKey.toBase58(),
    // earlyAccess: { windowSeconds, repoId, keepLauncher, rules, starsAtLaunch } — keepLauncher: the launcher's wallet is linked to
    // a contributor in the repository's snapshot, so a first buy leaves it on the list. rules: early access alone (default), with
    // the fair ramp, or with star unlocks too (src/early-access-rules.mjs); starsAtLaunch: the repository's star count now.
    async prepare({ launcherWallet, tokenName, tokenSymbol, initialBuyLamports = '0', earlyAccess }) {
      const launcher = new PublicKey(launcherWallet)
      if (launcher.equals(creator.publicKey)) throw new Error('Launcher and platform creator must differ')
      if (!earlyAccess || !/^[1-9]\d{0,15}$/.test(String(earlyAccess.repoId))) throw new Error('Early access launch needs its repository and window')
      const rules = earlyAccess.rules ?? RULES.EARLY_ACCESS
      if (!HOOK_RULE_SETS.includes(rules)) throw new Error('Early access launch options are not one of the offered sets')
      const { fixed, table, chainNow } = await readSetup()
      const end = earlyAccessEnd({ windowSeconds: earlyAccess.windowSeconds, wallNow: Math.floor(now() / 1000), chainNow })
      const buy = launchBuyQuote(client, fixed, initialBuyLamports)
      // With the fair ramp the launcher's first buy is held to the ramp's start too (the hook refuses more): refused here, with the most
      // it may get, rather than as a failed launch.
      const firstBuyCap = firstBuyCapBaseUnits(fixed, rules)
      if (buy && firstBuyCap !== null && BigInt(buy.outputAmount.toString()) > firstBuyCap) {
        throw new EarlyAccessLaunchError(`With the fair ramp, the first buy can get at most ${FAIR_RAMP.startBps / 100}% of the supply. Enter less SOL.`)
      }
      const ramp = hasFairRamp(rules) ? rampSettings(fixed, { starUnlocks: hasStarUnlocks(rules), starsAtLaunch: earlyAccess.starsAtLaunch }) : undefined
      const mint = Keypair.generate()
      const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, configKey), vault = dbcBaseVault(mint.publicKey, pool)
      const createPoolParam = { baseMint: mint.publicKey, config: configKey, name: tokenName, symbol: tokenSymbol,
        uri: earlyAccessMetadataUri(metadataOrigin, earlyAccess.repoId),
        payer: launcher, poolCreator: creator.publicKey, transferHookProgram: hook }
      // The first buy names the hook's accounts itself: the mint does not exist until this transaction creates it.
      const built = buy ? await client.creator.createPoolWithFirstBuyWithTransferHook({ createPoolParam,
        firstBuyParam: { buyer: launcher, buyAmount: new BN(initialBuyLamports), minimumAmountOut: buy.minimumAmountOut, referralTokenAccount: null,
          transferHookAccountsInfo: { slices: [{ accountsType: AccountsType.TransferHookBase, length: 5 }] },
          transferHookAccounts: transferHookAccounts(mint.publicKey, vault, hook) } })
        : await client.creator.createPoolWithTransferHook(createPoolParam)
      const removeLauncher = Boolean(buy) && !earlyAccess.keepLauncher
      // The SDK's own compute budget instructions are dropped: the launch sets its budget exactly once (duplicates fail).
      const instructions = [
        initMintInstruction({ payer: launcher, admin: creator.publicKey, mint: mint.publicKey, repoId: earlyAccess.repoId, rules,
          earlyAccessEnd: end, wallets: buy ? [launcher] : [], pool, vault, ...ramp ? { ramp } : {}, programId: hook }),
        ...built.instructions.filter(ix => !isBudget(ix)),
        ...removeLauncher ? [removeWalletsInstruction({ authority: creator.publicKey, mint: mint.publicKey, wallets: [launcher], programId: hook })] : [],
      ]
      const latest = await connection.getLatestBlockhash('confirmed')
      const { transaction: tx, ...landing } = await withVersionedLaunchPriorityFee(connection, instructions,
        { feePayer: launcher, blockhash: latest.blockhash, lookupTables: [table] })
      // Long token names (multi-byte characters count several bytes each) can push a launch with a first buy past Solana's size limit.
      const size = tx.serialize().length
      if (size > PACKET_DATA_SIZE) {
        console.warn('early_access_launch_too_large', { bytes: size })
        throw new EarlyAccessLaunchError('This early access launch does not fit in one Solana transaction. Use a shorter token name or ticker, or launch without an initial buy.')
      }
      return {
        mint: mint.publicKey.toBase58(), pool: pool.toBase58(), initialBuyOutput: buy?.outputAmount.toString() ?? null,
        blockhash: latest.blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        priorityFee: { computeUnitLimit: landing.computeUnitLimit, microLamports: landing.microLamports, lamports: landing.priorityFeeLamports.toString() },
        earlyAccess: { end, hookProgram: hook.toBase58(), launcherListed: Boolean(buy) && !removeLauncher, rules,
          ...ramp ? { ramp: Object.fromEntries(Object.entries(ramp).map(([field, value]) => [field, value.toString()])) } : {} },
        transaction: tx, mintSecretKey: mint.secretKey,
        sign: prepareVersionedLaunchSigning(tx, launcher, creator, mint, loadLookupTables),
      }
    },
    restore({ transaction, mintSecretKey, mint, launcherWallet, blockhash, lastValidBlockHeight }) {
      let tx
      try { tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64')) } catch { tx = null }
      const launcher = new PublicKey(launcherWallet)
      const mintKeypair = Keypair.fromSecretKey(mintSecretKey)
      if (mintKeypair.publicKey.toBase58() !== mint) throw new DefinitiveLaunchError('Prepared launch mint does not match its key')
      if (tx?.version !== 0 || !tx.message.staticAccountKeys[0]?.equals(launcher) || tx.message.recentBlockhash !== blockhash) {
        throw new DefinitiveLaunchError('Prepared launch transaction does not match its review')
      }
      return { mint, blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight), sign: prepareVersionedLaunchSigning(tx, launcher, creator, mintKeypair, loadLookupTables) }
    },
    submit: launch => sendLaunch(connection, launch),
    async inspect({ mint, pool, launchSignature }) {
      const status = (await connection.getSignatureStatuses([launchSignature], { searchTransactionHistory: true })).value[0]
      if (!status || status.err || !['confirmed', 'finalized'].includes(status.confirmationStatus)) return false
      const [state, mintInfo] = await Promise.all([client.state.getPool(pool), connection.getAccountInfo(new PublicKey(mint), 'confirmed')])
      return Boolean(state && mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) &&
        state.poolState.config.equals(configKey) && state.poolState.creator.equals(creator.publicKey) &&
        state.poolState.baseMint.equals(new PublicKey(mint)))
    },
  }
}
