import bs58 from 'bs58'
import BN from 'bn.js'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { launchBuyQuote } from './launch-buy.mjs'

export class DefinitiveLaunchError extends Error {}

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
      if (!fixed || !fixed.quoteMint.equals(NATIVE_MINT) || fixed.tokenType !== 0 || fixed.tokenDecimal !== 6 ||
          fixed.collectFeeMode !== 0 || fixed.migrationOption !== 1 ||
          fixed.poolFees.baseFee.cliffFeeNumerator.toString() !== '17500000' ||
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
      const latest = await connection.getLatestBlockhash('confirmed')
      tx.feePayer = launcher
      tx.recentBlockhash = latest.blockhash
      tx.partialSign(creator, mint)
      const message = Buffer.from(tx.serializeMessage())
      return {
        mint: mint.publicKey.toBase58(), pool: pool.toBase58(), initialBuyOutput: buy?.outputAmount.toString() ?? null,
        blockhash: latest.blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        async sign(signTransaction) {
          const signed = await signTransaction(tx)
          if (!(signed instanceof Transaction) || !Buffer.from(signed.serializeMessage()).equals(message) ||
              !signed.feePayer.equals(launcher) || !signed.verifySignatures()) {
            throw new DefinitiveLaunchError('Launcher returned an altered or incompletely signed transaction')
          }
          const launcherEntry = signed.signatures.find(entry => entry.publicKey.equals(launcher))
          if (!launcherEntry?.signature || !signed.signature) throw new DefinitiveLaunchError('Launcher signature missing')
          return { raw: signed.serialize(), signature: bs58.encode(signed.signature) }
        },
      }
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
