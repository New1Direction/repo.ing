import bs58 from 'bs58'
import BN from 'bn.js'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { launchBuyQuote } from './launch-buy.mjs'
import { isApprovedLaunchFee } from './launch-fee.mjs'
import { setLaunchWalletFees } from './launch-wallet-fees.mjs'
import { matchesReviewedLaunch } from './launch-wallet-assertions.mjs'

export class DefinitiveLaunchError extends Error {}

// Phantom must receive the transaction before the mint/creator co-signers sign.
// Capture the reviewed bytes; only trailing, constrained safety assertions may differ.
export function prepareLaunchSigning(tx, launcher, creator, mint) {
  const message = Buffer.from(tx.serializeMessage())
  return async signTransaction => {
    const signed = await signTransaction(tx)
    if (!matchesReviewedLaunch(message, signed) ||
        !signed.feePayer.equals(launcher)) {
      console.warn('launch_wallet_message_changed', {
        validTransaction: signed instanceof Transaction,
        blockhashChanged: signed?.recentBlockhash !== tx.recentBlockhash,
        payerChanged: !signed?.feePayer?.equals(launcher),
        expectedPrograms: tx.instructions.map(ix => ix.programId.toBase58()),
        returnedPrograms: signed instanceof Transaction ? signed.instructions.map(ix => ix.programId.toBase58()) : [],
        returnedInstructionKinds: signed instanceof Transaction ? signed.instructions.map(ix => ix.data[0]) : [],
      })
      throw new DefinitiveLaunchError('Your wallet changed the launch transaction. Refresh this page and review the launch again.')
    }
    const launcherEntry = signed.signatures.find(entry => entry.publicKey.equals(launcher))
    if (!launcherEntry?.signature || !signed.verifySignatures(false)) {
      throw new DefinitiveLaunchError('Launcher signature missing or invalid')
    }
    // Verify the user's signature over the whole returned message, assertions included.
    signed.partialSign(creator, mint)
    if (!signed.verifySignatures()) throw new DefinitiveLaunchError('Launch signatures are incomplete or invalid')
    return { raw: signed.serialize(), signature: bs58.encode(signed.signature) }
  }
}

// The config is created once using the curve in scripts/meteora-spike.mjs.
// A launch may choose metadata, but never fee, curve, migration, or quote settings.
export function createMeteoraLauncher({ connection, config, creator, metadataOrigin = null }) {
  const configKey = new PublicKey(config)
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  return {
    creatorWallet: creator.publicKey.toBase58(),
    async prepare({ launcherWallet, tokenName, tokenSymbol, initialBuyLamports = '0' }) {
      const launcher = new PublicKey(launcherWallet)
      if (launcher.equals(creator.publicKey)) throw new Error('Launcher and platform creator must differ')
      const fixed = await client.state.getPoolConfig(configKey)
      // Base fee: the proven flat 1.75%, or exactly the approved launch-fee schedule whose launcher first buy
      // pays 1.75% (src/launch-fee.mjs). Any other schedule could charge the launcher or traders differently.
      if (!fixed || !fixed.quoteMint.equals(NATIVE_MINT) || fixed.tokenType !== 0 || fixed.tokenDecimal !== 6 ||
          fixed.collectFeeMode !== 0 || fixed.migrationOption !== 1 || !isApprovedLaunchFee(fixed) ||
          fixed.poolFees.dynamicFee.initialized !== 0 || fixed.poolCreationFee.toString() !== '0' ||
          fixed.creatorTradingFeePercentage !== 71 || fixed.creatorPermanentLockedLiquidityPercentage !== 50 ||
          fixed.partnerPermanentLockedLiquidityPercentage !== 50 || fixed.creatorLiquidityPercentage !== 0 ||
          fixed.partnerLiquidityPercentage !== 0) {
        throw new Error('Configured DBC account does not match the tested fixed launch configuration')
      }
      const mint = Keypair.generate()
      const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, configKey)
      const createPoolParam = {
        baseMint: mint.publicKey, config: configKey, name: tokenName, symbol: tokenSymbol,
        uri: metadataOrigin ? `${metadataOrigin}/api/token-metadata/${mint.publicKey.toBase58()}` : '',
        payer: launcher, poolCreator: creator.publicKey,
      }
      const buy = launchBuyQuote(client, fixed, initialBuyLamports)
      const tx = buy ? await client.creator.createPoolWithFirstBuy({ createPoolParam,
        firstBuyParam: { buyer: launcher, buyAmount: new BN(initialBuyLamports),
          minimumAmountOut: buy.minimumAmountOut, referralTokenAccount: null } })
        : await client.creator.createPool(createPoolParam)
      setLaunchWalletFees(tx)
      const latest = await connection.getLatestBlockhash('confirmed')
      tx.feePayer = launcher
      tx.recentBlockhash = latest.blockhash
      return {
        mint: mint.publicKey.toBase58(), pool: pool.toBase58(), initialBuyOutput: buy?.outputAmount.toString() ?? null,
        blockhash: latest.blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        // For a review persisted across requests: the unsigned transaction the wallet reviews and the mint secret,
        // which the caller must store only sealed (src/launch-sessions.mjs).
        transaction: tx, mintSecretKey: mint.secretKey,
        sign: prepareLaunchSigning(tx, launcher, creator, mint),
      }
    },
    // Rebuilds a prepared launch on any replica from the reviewed unsigned transaction (base64, exactly as the wallet
    // received it) and the mint secret. Signing keeps every check of prepareLaunchSigning against those exact bytes.
    restore({ transaction, mintSecretKey, mint, launcherWallet, blockhash, lastValidBlockHeight }) {
      const tx = Transaction.from(Buffer.from(transaction, 'base64'))
      const launcher = new PublicKey(launcherWallet)
      const mintKeypair = Keypair.fromSecretKey(mintSecretKey)
      if (mintKeypair.publicKey.toBase58() !== mint) throw new DefinitiveLaunchError('Prepared launch mint does not match its key')
      if (!tx.feePayer?.equals(launcher) || tx.recentBlockhash !== blockhash) throw new DefinitiveLaunchError('Prepared launch transaction does not match its review')
      return { mint, blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight), sign: prepareLaunchSigning(tx, launcher, creator, mintKeypair) }
    },
    async submit({ raw, signature, blockhash, lastValidBlockHeight }) {
      await connection.sendRawTransaction(raw, { skipPreflight: false })
      const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight: Number(lastValidBlockHeight) }, 'confirmed')
      if (result.value.err) throw new DefinitiveLaunchError(`Launch transaction failed: ${JSON.stringify(result.value.err)}`)
    },
    async inspect({ mint, pool, launchSignature }) {
      const status = (await connection.getSignatureStatuses([launchSignature], { searchTransactionHistory: true })).value[0]
      if (!status || status.err || !['confirmed', 'finalized'].includes(status.confirmationStatus)) return false
      const [state, mintInfo] = await Promise.all([client.state.getPool(pool), connection.getAccountInfo(new PublicKey(mint), 'confirmed')])
      return Boolean(state && mintInfo?.owner.equals(TOKEN_PROGRAM_ID) &&
        state.poolState.config.equals(configKey) && state.poolState.creator.equals(creator.publicKey) &&
        state.poolState.baseMint.equals(new PublicKey(mint)))
    },
  }
}
