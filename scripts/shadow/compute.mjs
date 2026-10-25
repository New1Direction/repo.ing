// One frozen cycle per isolated process. This module never receives a DB connection.
import { Connection, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient, CollectFeeMode } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { canonicalTradeEvents, canonicalDbcSwapEvents } from '../../src/trade-evidence.mjs'
import { dammSwapEvents } from '../../src/damm-trades.mjs'
import { chartMigration } from '../../src/market-chart.mjs'
import { createMarketConfigResolver, readPoolConfig } from '../../src/market-config.mjs'
import { createCustodyRecovery } from '../../src/custody-recovery.mjs'
import { eligibleDiscoveryFee } from '../../src/discovery-rewards.mjs'
import { agreedFinalizedTransaction, agreeGraduation, readGraduationState } from '../../src/graduation-state.mjs'
import { clearFinalizedTransactionCache } from '../../src/finalized-transaction.mjs'
import { createGraduatedFees } from '../../src/graduated-fees.mjs'
import { publicGraduation } from '../../src/graduation-readiness.mjs'
import { canonicalJSON, digest, queryNames } from './boundary.mjs'

async function history(rpcs, address, boundary, lane) {
  if (!boundary) throw Error('SHADOW_BASELINE_REQUIRED')
  const pageSize = lane === 'chart' ? 100 : 1000, maxPages = lane === 'chart' ? 10 : 20
  const walk = async rpc => {
    const result = [], seen = new Set(); let before
    for (let page = 0; page < maxPages; page++) {
      const rows = await rpc.getSignaturesForAddress(new PublicKey(address), { limit: pageSize, ...(before ? { before } : {}) }, 'finalized')
      for (const { signature, slot, err } of rows) {
        if (signature === boundary) return result.reverse()
        if (seen.has(signature)) throw Error('SHADOW_HISTORY_DUPLICATE')
        seen.add(signature); result.push({ signature, slot, err })
      }
      if (rows.length < pageSize) throw Error('SHADOW_HISTORY_INCOMPLETE')
      before = rows.at(-1).signature
    }
    throw Error('SHADOW_HISTORY_LIMIT')
  }
  return agreeGraduation(...await Promise.all(rpcs.map(walk)))
}

const eventKey = e => `${e.signature}:${e.event_index ?? e.eventIndex}`
const total = (rows, repoId) => rows.filter(r => r.github_repo_id === repoId).reduce((n, r) => n + BigInt(r.amount_base_units), 0n)
function assertExisting(existing, candidate) {
  if (existing && Object.entries(candidate).some(([k, v]) => String(existing[k]) !== String(v))) throw Error('SHADOW_STORED_CONTRADICTION')
}

async function chart(packet, market, rpcs, timing, capture, setReplayTime) {
  const db = packet.db, graduation = db.graduates.find(r => r.github_repo_id === market.repoId)
  const migration = chartMigration(market, graduation), address = migration?.pool ?? market.pool
  const pair = [rpcs.primary, migration ? rpcs.archive : rpcs.verification]
  const configKey = createMarketConfigResolver(packet.config, packet.legacyConfigs, null)(market)
  const cursor = db.chartCursors.find(r => r.pool === address)
  const baseline = cursor?.signature ?? db.cursors.find(r => r.pool === address)?.last_signature
  const items = await history(pair, address, baseline, 'chart')
  const dbc = new DynamicBondingCurveClient(pair[0], 'finalized'), coder = new CpAmm(pair[0])._program.coder
  const candidates = [], additions = [], keys = new Set((migration ? db.dammTrades : db.trades).map(eventKey))
  for (const item of items) {
    if (item.err) continue
    const tx = await agreedFinalizedTransaction(...pair, item.signature)
    if (tx.slot !== item.slot || (migration && BigInt(tx.slot) < BigInt(migration.slot))) throw Error('SHADOW_SLOT_MISMATCH')
    const events = migration ? dammSwapEvents(tx, market, address, coder)
      : canonicalTradeEvents(tx, { ...market, signature: item.signature }, configKey, dbc)
    for (const e of events) {
      const row = { ...e, signature: item.signature, pool: address, slot: item.slot }
      candidates.push(row)
      if (!keys.has(eventKey(row))) { keys.add(eventKey(row)); additions.push(row) }
    }
  }
  // db=null is intentional: graduation proof discovery is bounded by the RPC tape and cannot persist proofs.
  const state = await readGraduationState({ connection: pair[0], verification: pair[1], market,
    config: packet.config, custodyRecovery: packet.custody, db: null, env: { NODE_ENV: 'production' } })
  // checkedAt is assigned where the strict 120000ms acquisition guard runs, before any migration reads.
  if (capture) timing.acquiredAt = state.checkedAt
  if (state.checkedAt !== timing.acquiredAt) throw Error('SHADOW_TIMING_INVALID')
  if (capture) timing.validatedAt = new Date().toISOString()
  else setReplayTime(timing.validatedAt)
  if (state.migration) {
    if (!migration) throw Error('SHADOW_MIGRATION_UNINDEXED')
    const threshold = Date.parse(timing.validatedAt) - 86400000
    const stored = db.dammTrades.filter(r => r.github_repo_id === market.repoId && r.pool === migration.pool &&
      BigInt(r.slot) >= BigInt(migration.slot) && Date.parse(r.traded_at) >= threshold)
    state.dammVolume24hLamports = String(stored.reduce((n, r) => n + BigInt(r.quote_amount), 0n) +
      additions.filter(r => r.tradedAt.getTime() >= threshold).reduce((n, r) => n + BigInt(r.quoteAmount), 0n))
  }
  // Retain the independent 300000ms public guard at validation, never at cycle completion.
  publicGraduation({ status: 'VERIFIED', observation: JSON.stringify(state), migration_evidence_hash: graduation?.evidence_hash }, Date.parse(timing.validatedAt))
  const { accountEvidence, positionEvidence, platform, partnerWallet, ...display } = state
  return { repoId: market.repoId, transactions: items.length, events: candidates.length, inserted: additions.length,
    inputWindow: digest(items), cursorBefore: digest(baseline), cursorAfter: digest(items.at(-1) ?? baseline),
    eventsDigest: digest(candidates), additionsDigest: digest(additions), observationDigest: digest(display), phase: state.phase }
}

async function accounting(packet, market, rpcs) {
  const pair = [rpcs.primary, rpcs.verification], db = packet.db
  const configKey = createMarketConfigResolver(packet.config, packet.legacyConfigs, null)(market)
  const baseline = db.cursors.find(r => r.pool === market.pool)?.last_signature ?? market.launchSignature
  const items = await history(pair, market.pool, baseline, 'accounting')
  const clients = pair.map(c => new DynamicBondingCurveClient(c, 'finalized'))
  const states = await Promise.all(clients.map(c => c.state.getPool(market.pool)))
  const configs = await Promise.all(clients.map(c => readPoolConfig(c, configKey)))
  agreeGraduation(...states); agreeGraduation(...configs)
  const state = states[0], fixed = configs[0], custody = createCustodyRecovery(packet.custody)
  if (!state || !fixed || state.poolState.creator.toBase58() !== custody.creator(market, configKey) ||
    !state.poolState.config.equals(configKey) || !state.poolState.baseMint.equals(new PublicKey(market.mint)) ||
    !fixed.quoteMint.equals(NATIVE_MINT) || fixed.collectFeeMode !== CollectFeeMode.QuoteToken ||
    fixed.creatorTradingFeePercentage <= 0 || fixed.creatorTradingFeePercentage > 100) throw Error('SHADOW_FEE_STATE')
  const candidates = [], additions = [], discovery = [], newDiscovery = []
  const known = new Map(db.fees.filter(r => r.kind === 'dbc_creator_quote').map(r => [eventKey(r), r]))
  const knownDiscovery = new Map(db.discovery.map(r => [eventKey(r), r]))
  for (const item of items) {
    if (item.err) continue
    const tx = await agreedFinalizedTransaction(...pair, item.signature)
    if (tx.slot !== item.slot) throw Error('SHADOW_SLOT_MISMATCH')
    const { events, sawCanonicalSwap, sawCanonicalFeeEvent } = canonicalDbcSwapEvents(tx, market, configKey, clients[0])
    if (sawCanonicalSwap && !sawCanonicalFeeEvent) throw Error('SHADOW_FEE_EVIDENCE')
    for (const { eventIndex, data } of events) {
      const tradingFee = BigInt(data.swapResult.tradingFee.toString())
      const amount = tradingFee * BigInt(fixed.creatorTradingFeePercentage) / 100n, partner = tradingFee - amount
      const common = { github_repo_id: market.repoId, pool: market.pool, signature: item.signature, event_index: eventIndex, slot: String(item.slot) }
      if (amount > 0n) {
        const row = { ...common, mint: market.mint, amount_base_units: String(amount), kind: 'dbc_creator_quote' }
        assertExisting(known.get(eventKey(row)), row)
        candidates.push(row)
        if (!known.has(eventKey(row))) { additions.push(row); known.set(eventKey(row), row) }
      }
      if (partner > 0n) {
        const row = { ...common, partner_amount: String(partner), discovery_eligible: eligibleDiscoveryFee(market, data),
          traded_at: new Date(Number(data.currentTimestamp.toString()) * 1000).toISOString() }
        assertExisting(knownDiscovery.get(eventKey(row)), row)
        discovery.push(row)
        if (!knownDiscovery.has(eventKey(row))) { newDiscovery.push(row); knownDiscovery.set(eventKey(row), row) }
      }
    }
  }
  const loadTransaction = (_rpc, signature) => agreedFinalizedTransaction(...pair, signature)
  const snapshots = await Promise.all(pair.map(c => createGraduatedFees({ connection: c, config: packet.config,
    custodyRecovery: packet.custody, persistProof: false, db: null, loadTransaction }).read(market, state, fixed)))
  agreeGraduation(...snapshots.map(s => s && { evidence: s.evidence, partner: s.partner.evidence }))
  const graduate = snapshots[0]
  const graduatedCredit = graduate ? graduate.earned - total(db.graduated, market.repoId) : 0n
  const partnerCredit = graduate ? graduate.partner.earned - total(db.platform, market.repoId) : 0n
  if (graduatedCredit < 0n || partnerCredit < 0n) throw Error('SHADOW_ENTITLEMENT_DECREASED')
  return { repoId: market.repoId, transactions: items.length, events: candidates.length, inserted: additions.length,
    creditedBaseUnits: String(total(additions, market.repoId)), partnerBaseUnits: String(newDiscovery.reduce((n, r) => n + BigInt(r.partner_amount), 0n)),
    graduatedCredit: String(graduatedCredit), partnerCredit: String(partnerCredit),
    inputWindow: digest(items), cursorBefore: digest(baseline), cursorAfter: digest(items.at(-1) ?? baseline),
    eventsDigest: digest(candidates), additionsDigest: digest(additions), discoveryDigest: digest(discovery),
    graduatedDigest: digest(graduate && { evidence: graduate.evidence, partner: graduate.partner.evidence,
      earned: graduate.earned, claimed: graduate.claimed, slot: graduate.slot, partnerEarned: graduate.partner.earned, partnerClaimed: graduate.partner.claimed }) }
}

function validateTiming(packet, markets) {
  const time = value => {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw Error('SHADOW_TIMING_INVALID')
    return ms
  }
  let previous = time(packet.at)
  const end = time(packet.completedAt)
  if (end < previous || end - previous > 900000 || !Array.isArray(packet.timings) || packet.timings.length !== markets.length) throw Error('SHADOW_TIMING_INVALID')
  for (const [i, market] of markets.entries()) {
    const t = packet.timings[i]
    if (!t || t.repoId !== market.repoId || (i && market.repoId === markets[i - 1].repoId)) throw Error('SHADOW_TIMING_INVALID')
    const start = time(t.startedAt), acquired = time(t.acquiredAt), validated = time(t.validatedAt)
    if (start < previous || acquired < start || validated < acquired || validated > end) throw Error('SHADOW_TIMING_INVALID')
    previous = validated
  }
}

let running = false
export async function computeShadow(packet, tape, { capture = false } = {}) {
  if (running) throw Error('SHADOW_ISOLATION_REQUIRED')
  tape.assertSafe()
  if (packet.version !== 2 || !['chart', 'accounting'].includes(packet.lane) || !Number.isFinite(Date.parse(packet.at)) ||
    !packet.db?.markets?.length || packet.db.markets.length > 1000 ||
    queryNames(packet.lane).some(k => !Array.isArray(packet.db[k])) ||
    packet.db.markets.some(m => !/^[1-9]\d*$/.test(m.repoId))) throw Error('SHADOW_PACKET_INVALID')
  const previousFetch = globalThis.fetch, RealDate = globalThis.Date, legacy = process.env.DBC_LEGACY_CONFIGS
  const markets = [...packet.db.markets].sort((a, b) => BigInt(a.repoId) < BigInt(b.repoId) ? -1 : 1)
  if (capture) {
    if (packet.timings !== undefined || packet.completedAt !== undefined) throw Error('SHADOW_TIMING_INVALID')
    packet.timings = []
  } else validateTiming(packet, markets)
  let now = Date.parse(packet.at)
  const id = digest(packet), setReplayTime = at => { now = RealDate.parse(at) }
  running = true
  // Frozen wall clock is confined to this isolated process; source production modules remain unchanged.
  if (!capture) globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  process.env.DBC_LEGACY_CONFIGS = packet.legacyConfigs
  const endpoints = Object.fromEntries(['primary', 'verification', 'archive'].map(p => [p, `https://${p}.shadow.invalid/${id}`]))
  globalThis.fetch = async (url, options) => {
    const provider = Object.keys(endpoints).find(p => endpoints[p] === String(url))
    if (!provider) throw Error('SHADOW_RPC_DENIED')
    const request = JSON.parse(options.body)
    const result = await tape.request(provider, request.method, request.params ?? [])
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 })
  }
  clearFinalizedTransactionCache()
  try {
    const rpcs = Object.fromEntries(Object.entries(endpoints).map(([p, endpoint]) => [p,
      new Connection(endpoint, { commitment: 'finalized', fetch: globalThis.fetch, disableRetryOnRateLimit: true })]))
    // Always make the tape prove network identity, including replay; do not let library caches skip this guard.
    for (const p of Object.keys(endpoints)) if (await tape.request(p, 'getGenesisHash', []) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw Error('SHADOW_NETWORK_MISMATCH')
    const results = []
    for (const [i, market] of markets.entries()) {
      const timing = capture ? { repoId: market.repoId, startedAt: new RealDate().toISOString() } : packet.timings[i]
      if (!capture) setReplayTime(timing.acquiredAt)
      const result = await (packet.lane === 'chart' ? chart : accounting)(packet, market, rpcs, timing, capture, setReplayTime)
      if (capture) {
        if (packet.lane === 'accounting') timing.acquiredAt = timing.validatedAt = new RealDate().toISOString()
        packet.timings.push(timing)
      }
      results.push({ ...result, asOf: { ...timing } })
    }
    if (capture) { packet.completedAt = new RealDate().toISOString(); validateTiming(packet, markets) }
    tape.assertSafe()
    return { lane: packet.lane, at: packet.at, completedAt: packet.completedAt,
      databaseWrites: 0, writerLocks: 0, markets: results, outputDigest: digest(results) }
  } finally {
    globalThis.fetch = previousFetch; globalThis.Date = RealDate
    if (legacy === undefined) delete process.env.DBC_LEGACY_CONFIGS; else process.env.DBC_LEGACY_CONFIGS = legacy
    running = false
  }
}
