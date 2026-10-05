import bs58 from 'bs58'
import BN from 'bn.js'
import { Keypair, PublicKey, SendTransactionError, Transaction, TransactionExpiredBlockheightExceededError } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress, deriveTokenBadgeAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { SOL_QUOTE } from './quote-assets.mjs'
import { launchBuyQuote } from './launch-buy.mjs'
import { isApprovedLaunchFee } from './launch-fee.mjs'
import { withLaunchPriorityFee } from './launch-wallet-fees.mjs'
import { matchesReviewedLaunch } from './launch-wallet-assertions.mjs'
import { LAUNCH_REVIEW_EXPIRED } from './launch-expiry.mjs'

// The launch did not happen and cannot happen from this attempt, so it may be reviewed again. The name is set explicitly:
// the production build renames classes, and launchFailure (src/launch-failure.mjs) recognizes this error by its name.
export class DefinitiveLaunchError extends Error {
  constructor(message) { super(message); this.name = 'DefinitiveLaunchError' }
}

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
// quote: SOL (default) or a resolved stock asset (src/quote-assets.mjs) whose own config this is. A stock quote is a Token-2022
// mint with extensions, which DBC accepts only with Meteora's token badge for it, passed with the pool creation. Stock-paired
// launches have no initial buy yet.
export function createMeteoraLauncher({ connection, config, creator, metadataOrigin = null, quote = SOL_QUOTE }) {
  const configKey = new PublicKey(config)
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const stock = quote.type !== 'SOL'
  const quoteMint = stock ? new PublicKey(quote.mint) : NATIVE_MINT
  return {
    creatorWallet: creator.publicKey.toBase58(),
    async prepare({ launcherWallet, tokenName, tokenSymbol, initialBuyLamports = '0' }) {
      const launcher = new PublicKey(launcherWallet)
      if (launcher.equals(creator.publicKey)) throw new Error('Launcher and platform creator must differ')
      if (stock && BigInt(initialBuyLamports) !== 0n) throw new Error('Stock-paired launches have no initial buy yet. Buy after the launch.')
      const fixed = await client.state.getPoolConfig(configKey)
      // Base fee: the proven flat 1.75%, or exactly the approved launch-fee schedule whose launcher first buy
      // pays 1.75% (src/launch-fee.mjs). Any other schedule could charge the launcher or traders differently.
      // A stock config must also quote that stock's mint through Token-2022 (quoteTokenFlag 1).
      if (stock && (!fixed || fixed.quoteTokenFlag !== 1)) throw new Error('Configured DBC account does not match the stock pair')
      if (!fixed || !fixed.quoteMint.equals(quoteMint) || fixed.tokenType !== 0 || fixed.tokenDecimal !== 6 ||
          fixed.collectFeeMode !== 0 || fixed.migrationOption !== 1 || !isApprovedLaunchFee(fixed) ||
          fixed.poolFees.dynamicFee.initialized !== 0 || fixed.poolCreationFee.toString() !== '0' ||
          fixed.creatorTradingFeePercentage !== 71 || fixed.creatorPermanentLockedLiquidityPercentage !== 50 ||
          fixed.partnerPermanentLockedLiquidityPercentage !== 50 || fixed.creatorLiquidityPercentage !== 0 ||
          fixed.partnerLiquidityPercentage !== 0) {
        throw new Error('Configured DBC account does not match the tested fixed launch configuration')
      }
      // Meteora's badge for the stock mint must exist, or DBC refuses the pool; checked here so the launcher sees why.
      const tokenBadge = stock ? deriveTokenBadgeAddress(quoteMint) : null
      if (tokenBadge && !await connection.getAccountInfo(tokenBadge, 'confirmed')) throw new Error(`${quote.symbol} is not approved for new pools on Meteora`)
      const mint = Keypair.generate()
      const pool = deriveDbcPoolAddress(quoteMint, mint.publicKey, configKey)
      const createPoolParam = {
        baseMint: mint.publicKey, config: configKey, name: tokenName, symbol: tokenSymbol,
        uri: metadataOrigin ? `${metadataOrigin}/api/token-metadata/${mint.publicKey.toBase58()}` : '',
        payer: launcher, poolCreator: creator.publicKey, ...tokenBadge ? { tokenBadge } : {},
      }
      const buy = launchBuyQuote(client, fixed, initialBuyLamports)
      const built = buy ? await client.creator.createPoolWithFirstBuy({ createPoolParam,
        firstBuyParam: { buyer: launcher, buyAmount: new BN(initialBuyLamports),
          minimumAmountOut: buy.minimumAmountOut, referralTokenAccount: null } })
        : await client.creator.createPool(createPoolParam)
      const latest = await connection.getLatestBlockhash('confirmed')
      const { transaction: tx, ...landing } = await withLaunchPriorityFee(connection, built, { feePayer: launcher, blockhash: latest.blockhash })
      return {
        mint: mint.publicKey.toBase58(), pool: pool.toBase58(), initialBuyOutput: buy?.outputAmount.toString() ?? null,
        blockhash: latest.blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        priorityFee: { computeUnitLimit: landing.computeUnitLimit, microLamports: landing.microLamports, lamports: landing.priorityFeeLamports.toString() },
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
      // Signed after its blockhash expired: it is never sent, and only this process holds the co-signed bytes, so it
      // cannot land. The same holds when the height cannot be read: nothing has been sent yet.
      let height
      try { height = await connection.getBlockHeight('confirmed') }
      catch { throw new DefinitiveLaunchError('Could not reach Solana to send the launch, so nothing was sent or charged. Refresh the review and try again.') }
      if (height > Number(lastValidBlockHeight)) throw new DefinitiveLaunchError(LAUNCH_REVIEW_EXPIRED)
      try { await connection.sendRawTransaction(raw, { skipPreflight: false }) }
      catch (error) {
        // An error answer from the RPC (failed simulation or validation) means it refused the transaction and did not
        // forward it. A transport failure (timeout, dropped connection) is unknown and stays ambiguous, and so does
        // "already processed": the transaction is sent once, so that answer would mean it landed.
        if (!(error instanceof SendTransactionError)) throw error
        const reason = String(error.transactionError?.message ?? error.message ?? '')
        console.warn('launch_send_refused', { reason: reason.slice(0, 200) })
        if (/already (been )?processed/i.test(reason)) throw error
        throw new DefinitiveLaunchError(/blockhash not found|block height exceeded|expired/i.test(reason) ? LAUNCH_REVIEW_EXPIRED
          : 'Solana refused the launch transaction before sending it, so nothing was charged. Refresh the review and try again.')
      }
      let result
      try { result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight: Number(lastValidBlockHeight) }, 'confirmed') }
      catch (error) {
        // Sent, but not confirmed before its blockhash expired: still unknown, so the attempt stays ambiguous until the
        // worker proves it never landed (src/launch-expiry.mjs).
        if (error instanceof TransactionExpiredBlockheightExceededError) {
          throw new Error('The launch was sent but did not confirm before its transaction expired. If it did not land, you can launch again in about two minutes.')
        }
        throw error
      }
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
