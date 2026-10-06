// Bundle launch simulation: each real market's public SOL flows replayed on a bundle market of the same launch time.
import { readFileSync } from 'node:fs'
import { Curve, THRESHOLD } from './engine.mjs'
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const SOL = 1e9, DAY = 86_400, COOLDOWN = 180
const POLICY = { maxTradeBps: 200, maxDailyBuyBps: 1_000, maxDailySellBps: 100, floorBps: 10_000, gapSecs: 600 }
const AGENT = { sellAt: 1.5, dipFromHigh: 0.15 } // sell above 1.5× cost; buy after a 15% fall from the 24 h high
const byPool = new Map(); for (const t of data.trades) (byPool.get(t[0]) ?? byPool.set(t[0], []).get(t[0])).push(t)
const bps = (x, b) => x * BigInt(b) / 10_000n

// Public flows: a buy as the gross SOL paid (the recorded input is after the fee), a sell as the SOL received.
function publicFlows(m) {
  const real = new Curve(m.launched), flows = []
  let launchBuy = 0n
  for (const [, t, d, i, o, p, launch] of byPool.get(m.pool) ?? []) {
    let gross = BigInt(i) * 10_000n / 9_825n
    try { if (d === 'buy') gross = real.buyTokens(BigInt(o), t, launch).spent } catch {}
    real.state.poolState.sqrtPrice = new (real.state.poolState.sqrtPrice.constructor)(p)
    if (launch) { if (d === 'buy') launchBuy += gross; continue }
    flows.push(d === 'buy' ? { t, buy: gross } : { t, sell: BigInt(o) })
  }
  return { flows, launchBuy }
}

function run(m, flows, { raise = 0n, launchBuy = 0n, agent = true }) {
  const c = new Curve(m.launched), t0 = m.launched
  const acc = { publicIn: 0n, publicOut: 0n, publicTokens: 0n, backer: 0n, treasury: 0n, rebate: 0n, builders: 0n, meteora: 0n, partnerPublic: 0n, vaultTrades: 0 }
  const vault = { sol: 0n, tokens: 0n, costL: 0n, costT: 0n, day: -1, bought: 0n, sold: 0n, lastBuy: 0, lastSell: 0, high: [] }
  const book = (r, isVault) => {
    acc.builders += r.fee.creator; acc.meteora += r.fee.protocol
    if (isVault) acc.rebate += r.fee.partner
    else { acc.partnerPublic += r.fee.partner; const b = r.fee.partner * 8_000n / 10_000n; acc.backer += b; acc.treasury += r.fee.partner - b }
  }
  if (raise > 0n) {
    const buy = raise - bps(raise, 500), r = c.buy(buy, t0, true)
    vault.tokens = r.tokens; vault.costL = r.spent; vault.costT = r.tokens; book(r, true)
  } else if (launchBuy > 0n) { const r = c.buy(launchBuy, t0, true); acc.publicTokens += r.tokens; book(r, false) }
  let graduatedAt = null
  const step = t => {
    if (!agent || raise === 0n || t < t0 + COOLDOWN || c.graduated) return
    const day = Math.floor(t / DAY); if (day !== vault.day) { vault.day = day; vault.bought = 0n; vault.sold = 0n }
    const price = c.price(), cost = Number(vault.costL) / Number(vault.costT || 1n)
    vault.high = vault.high.filter(([time]) => time > t - DAY); vault.high.push([t, price])
    const high = Math.max(...vault.high.map(([, value]) => value))
    if (price >= AGENT.sellAt * cost && vault.tokens > 0n && (!vault.lastBuy || t >= vault.lastBuy + POLICY.gapSecs)) {
      const cap = bps(vault.tokens + vault.sold, POLICY.maxDailySellBps) - vault.sold
      const amount = [bps(vault.tokens, POLICY.maxTradeBps), cap].reduce((a, b) => a < b ? a : b)
      if (amount <= 0n) return
      const saved = c.state.poolState.sqrtPrice, savedReserve = c.reserve
      const r = c.sellTokens(amount, t)
      if (Number(r.sol) < (POLICY.floorBps / 10_000) * cost * Number(amount)) { c.state.poolState.sqrtPrice = saved; c.reserve = savedReserve; return }
      const basis = vault.costL * amount / vault.costT
      vault.costL -= basis; vault.costT -= amount; vault.tokens -= amount; vault.sol += r.sol; vault.sold += amount; vault.lastSell = t
      book(r, true); acc.vaultTrades++
    } else if (price <= (1 - AGENT.dipFromHigh) * high && vault.sol > 0n && (!vault.lastSell || t >= vault.lastSell + POLICY.gapSecs)) {
      const cap = bps(vault.sol + vault.bought, POLICY.maxDailyBuyBps) - vault.bought
      const amount = [bps(vault.sol, POLICY.maxTradeBps), cap].reduce((a, b) => a < b ? a : b)
      if (amount <= 0n) return
      const r = c.buy(amount, t)
      vault.sol -= r.spent; vault.tokens += r.tokens; vault.costL += r.spent; vault.costT += r.tokens; vault.bought += r.spent; vault.lastBuy = t
      book(r, true); acc.vaultTrades++
    }
  }
  for (const f of flows) {
    if (c.graduated) break
    step(f.t)
    if (f.buy) { const r = c.buy(f.buy, f.t); if (!r) break; acc.publicIn += r.spent; acc.publicTokens += r.tokens; book(r, false) }
    else {
      let tokens; try { tokens = c.tokensFor(f.sell, f.t) } catch { tokens = acc.publicTokens }
      if (tokens > acc.publicTokens) tokens = acc.publicTokens
      if (tokens <= 0n) continue
      const r = c.sellTokens(tokens, f.t); acc.publicOut += r.sol; acc.publicTokens -= tokens; book(r, false)
    }
    if (c.graduated && graduatedAt === null) graduatedAt = f.t - t0
  }
  const price = c.price()
  // What the vault's tokens would really fetch: all of them sold into the curve now (after the launch fee).
  let exit = Number(vault.sol)
  if (vault.tokens > 0n && !c.graduated) {
    const saved = c.state.poolState.sqrtPrice, savedReserve = c.reserve
    try { exit += Number(c.sellTokens(vault.tokens, t0 + 10 * DAY).sol) } catch {}
    c.state.poolState.sqrtPrice = saved; c.reserve = savedReserve
  }
  const days = ((flows.at(-1)?.t ?? t0) - t0) / DAY
  return { ...acc, graduatedAt, exit, days, progress: Number(c.reserve) / Number(THRESHOLD), vaultSol: vault.sol, vaultTokens: vault.tokens,
    vaultMark: Number(vault.sol) + Number(vault.tokens) * price, publicMark: Number(acc.publicTokens) * price }
}

const markets = data.markets.filter(m => (byPool.get(m.pool) ?? []).length && m.token_symbol !== 'REPOING')
const base = new Map(markets.map(m => { const { flows, launchBuy } = publicFlows(m); return [m.pool, { flows, launchBuy, result: run(m, flows, { launchBuy }) }] }))
const s = x => Number(x) / SOL
const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0)
const baseRows = [...base.values()].map(v => v.result)
console.log(JSON.stringify({ markets: markets.length, publicVolumeSOL: +s(sum(baseRows, r => Number(r.publicIn + r.publicOut))).toFixed(1),
  baselineGraduated: baseRows.filter(r => r.graduatedAt !== null).length, baselineBuilderFees: +s(sum(baseRows, r => Number(r.builders))).toFixed(3),
  baselinePartnerFees: +s(sum(baseRows, r => Number(r.partnerPublic))).toFixed(3) }))
const ages = baseRows.map(r => r.days).sort((a, b) => a - b)
console.log(JSON.stringify({ tradeDaysMedian: +ages[Math.floor(ages.length / 2)].toFixed(1), tradeDaysMax: +ages.at(-1).toFixed(1),
  top5PublicVolume: markets.map(m => [m.token_symbol, +s(Number(base.get(m.pool).result.publicIn + base.get(m.pool).result.publicOut)).toFixed(1)]).sort((a, b) => b[1] - a[1]).slice(0, 5) }))
for (const raiseSol of [5, 10, 20, 40]) {
  const raise = BigInt(raiseSol) * BigInt(SOL)
  const rows = markets.map(m => ({ m, b: base.get(m.pool).result, r: run(m, base.get(m.pool).flows, { raise }) }))
  const backer = rows.map(x => s(x.r.backer)).sort((a, b) => a - b)
  const nav = rows.map(x => x.r.exit / Number(raise - bps(raise, 500))).sort((a, b) => a - b)
  const median = list => list[Math.floor(list.length / 2)]
  console.log(JSON.stringify({ raiseSOL: raiseSol,
    backerIncomeTotalSOL: +sum(backer, x => x).toFixed(3), backerIncomeMedianSOL: +median(backer).toFixed(4), backerIncomeBestSOL: +backer.at(-1).toFixed(3),
    backerReturnMedianPct: +(median(backer) / raiseSol * 100).toFixed(3), backerReturnBestPct: +(backer.at(-1) / raiseSol * 100).toFixed(2),
    vaultExitVsBuyMedian: +median(nav).toFixed(3), vaultExitVsBuyWorst: +nav[0].toFixed(3), vaultExitVsBuyBest: +nav.at(-1).toFixed(3),
    marketsWithBackerIncomeAboveRaise1Pct: backer.filter(x => x >= raiseSol / 100).length,
    vaultTrades: sum(rows, x => x.r.vaultTrades), rebateSOL: +s(sum(rows, x => Number(x.r.rebate))).toFixed(3),
    graduated: rows.filter(x => x.r.graduatedAt !== null).length, baselineGraduated: rows.filter(x => x.b.graduatedAt !== null).length,
    builderFeesSOL: +s(sum(rows, x => Number(x.r.builders))).toFixed(3), builderFeesBaselineSOL: +s(sum(rows, x => Number(x.b.builders))).toFixed(3),
    publicNetSOL: +s(sum(rows, x => Number(x.r.publicOut) - Number(x.r.publicIn))).toFixed(2), publicNetBaselineSOL: +s(sum(rows, x => Number(x.b.publicOut) - Number(x.b.publicIn))).toFixed(2),
    publicMarkSOL: +s(sum(rows, x => x.r.publicMark)).toFixed(2), publicMarkBaselineSOL: +s(sum(rows, x => x.b.publicMark)).toFixed(2) }))
}
