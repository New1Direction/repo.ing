import { PublicKey } from '@solana/web3.js'
import { createMarketConfigResolver } from './market-config.mjs'
import { NATIVE_MINT } from '@solana/spl-token'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, sql } from 'drizzle-orm'
import { CollectFeeMode, DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { discoveryFeeEvents, feeEvents, markets } from './db/schema.mjs'
import { eligibleDiscoveryFee } from './discovery-rewards.mjs'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'
import { canonicalDbcSwapEvents, UnparseableTradeError } from './trade-evidence.mjs'

const KIND = 'dbc_creator_quote'

export function createFeeAccrual({ pool: databasePool, connection, config }) {
  const resolveConfig = createMarketConfigResolver(config)
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const db = drizzle(databasePool)
  const earnedIn = async (executor, repoId) => {
    const [row] = await executor.select({ amount: sql`coalesce(sum(${feeEvents.amountBaseUnits}), 0)::text` })
      .from(feeEvents).where(eq(feeEvents.githubRepoId, repoId))
    return BigInt(row.amount)
  }
  const loadMarket = async (executor, repoId) => {
    const market = (await executor.select().from(markets).where(eq(markets.githubRepoId, repoId)).limit(1))[0]
    if (!market || market.status !== 'confirmed' || market.indexedAt === null || market.launchFinality !== 'finalized') {
      throw new Error('Repository has no indexed canonical market')
    }
    const mint = new PublicKey(market.mint)
    const configKey = resolveConfig(market)
    if (!deriveDbcPoolAddress(NATIVE_MINT, mint, configKey).equals(new PublicKey(market.pool))) {
      throw new Error('Canonical market does not match fixed DBC config')
    }
    return market
  }
  const evidenceFrom = async (signature, market, creatorPercentage, allowNonSwap) => {
    const configKey = resolveConfig(market)
    const transaction = await loadFinalizedTransaction(connection, signature)
    if (!transaction || !transaction.meta || transaction.meta.err) throw new Error(`Trade ${signature} has no successful finalized transaction evidence`)
    const { events: swaps, sawCanonicalSwap, sawCanonicalFeeEvent } =
      canonicalDbcSwapEvents(transaction, market, configKey, dbc)
    const discoveryEvents = []
    const events = swaps.flatMap(({ eventIndex, data }) => {
      const tradingFee = BigInt(data.swapResult.tradingFee.toString())
      const amount = tradingFee * BigInt(creatorPercentage) / 100n
      const partnerAmount = tradingFee - amount
      if (partnerAmount > 0n) {
        discoveryEvents.push({ githubRepoId: market.githubRepoId, pool: market.pool, signature, eventIndex,
          partnerAmount, discoveryEligible: eligibleDiscoveryFee(market, data),
          slot: BigInt(transaction.slot), tradedAt: new Date(Number(data.currentTimestamp.toString()) * 1000) })
      }
      return amount > 0n ? [{ githubRepoId: market.githubRepoId, mint: market.mint, pool: market.pool,
        signature, eventIndex, amountBaseUnits: amount, asset: NATIVE_MINT.toBase58(),
        kind: KIND, slot: BigInt(transaction.slot) }] : []
    })
    if (events.length === 0 && (!allowNonSwap || (sawCanonicalSwap && !sawCanonicalFeeEvent))) {
      throw new UnparseableTradeError(`Trade ${signature} has no canonical DBC creator-fee event`)
    }
    return { events, discoveryEvents }
  }
  const recordTradeFees = async ({ githubRepoId, signatures, allowNonSwap = false }) => {
    const repoId = BigInt(githubRepoId)
    if (!Array.isArray(signatures) || signatures.length === 0) throw new Error('Finalized trade signatures required')
    const client = await databasePool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId.toString()])
      try {
        const lockedDb = drizzle(client)
        const market = await loadMarket(lockedDb, repoId)
        const configKey = resolveConfig(market)
        const state = await dbc.state.getPool(market.pool)
        const fixed = await dbc.state.getPoolConfig(configKey)
        if (!state || !fixed || !state.poolState.creator.equals(new PublicKey(market.creatorWallet)) ||
            !state.poolState.config.equals(configKey) || !state.poolState.baseMint.equals(new PublicKey(market.mint)) ||
            !fixed.quoteMint.equals(NATIVE_MINT) || fixed.collectFeeMode !== CollectFeeMode.QuoteToken ||
            fixed.creatorTradingFeePercentage <= 0) {
          throw new Error('Canonical DBC creator fee state or fixed config does not match market')
        }
        const observedCreatorFee = BigInt(state.poolState.creatorQuoteFee.toString())
        const evidence = await Promise.all([...new Set(signatures)].map(signature =>
          evidenceFrom(signature, market, fixed.creatorTradingFeePercentage, allowNonSwap)))
        const candidates = evidence.flatMap(item => item.events)
        return lockedDb.transaction(async tx => {
          let earned = await earnedIn(tx, repoId)
          const additions = []
          for (const event of candidates) {
            const existing = (await tx.select().from(feeEvents).where(and(eq(feeEvents.signature, event.signature),
              eq(feeEvents.eventIndex, event.eventIndex), eq(feeEvents.kind, event.kind))).limit(1))[0]
            if (existing) {
              if (existing.githubRepoId !== repoId || existing.mint !== event.mint || existing.pool !== event.pool ||
                  existing.amountBaseUnits !== event.amountBaseUnits || existing.slot !== event.slot) {
                throw new Error('Stored fee event contradicts finalized chain evidence')
              }
            } else {
              earned += event.amountBaseUnits
              additions.push(event)
            }
          }
          for (const event of additions) await tx.insert(feeEvents).values(event)
          for (const event of evidence.flatMap(item => item.discoveryEvents)) {
            const [existing] = await tx.select().from(discoveryFeeEvents).where(and(
              eq(discoveryFeeEvents.signature, event.signature), eq(discoveryFeeEvents.eventIndex, event.eventIndex))).limit(1)
            if (existing) {
              if (existing.githubRepoId !== repoId || existing.pool !== event.pool || existing.partnerAmount !== event.partnerAmount ||
                  existing.discoveryEligible !== event.discoveryEligible || existing.slot !== event.slot || existing.tradedAt.getTime() !== event.tradedAt.getTime()) {
                throw new Error('Stored discovery fee contradicts finalized chain evidence')
              }
            } else await tx.insert(discoveryFeeEvents).values(event)
          }
          return { githubRepoId: repoId, earnedBaseUnits: earned, observedCreatorFee,
            creditedBaseUnits: additions.reduce((sum, event) => sum + event.amountBaseUnits, 0n),
            eventKeys: candidates.map(event => `${event.signature}:${event.eventIndex}:${event.kind}`) }
        })
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId.toString()]) }
    } finally { client.release() }
  }
  return { recordTradeFees, getRepositoryEarnings: async githubRepoId => {
    const { rows: [row] } = await databasePool.query('select coalesce(sum(amount_base_units),0)::text as total from builder_fee_credits where github_repo_id=$1', [String(githubRepoId)])
    return BigInt(row.total)
  } }
}
