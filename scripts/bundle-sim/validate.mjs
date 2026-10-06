import { readFileSync } from 'node:fs'
import { Curve } from './engine.mjs'
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const byPool = new Map(); for (const t of data.trades) (byPool.get(t[0]) ?? byPool.set(t[0], []).get(t[0])).push(t)
let good = 0, total = 0, marketsOk = 0, firstBad = []
for (const m of data.markets) {
  const trades = byPool.get(m.pool) ?? []
  if (!trades.length) continue
  const curve = new Curve(m.launched)
  let allOk = true
  for (const [, t, d, i, o, p, launch] of trades) {
    // Re-sync to the recorded price before each trade, so one mismatch does not cascade.
    const before = curve.state.poolState.sqrtPrice
    let r = null
    try { r = d === 'buy' ? curve.buyTokens(BigInt(o), t, launch) : curve.sellTokens(BigInt(i), t) } catch { r = { failed: true } }
    if (!r) break
    total++
    if (r.failed) { allOk = false; if (firstBad.length < 6) firstBad.push(`${m.token_symbol} ${d} threw t+${t - m.launched}s`); curve.state.poolState.sqrtPrice = new (before.constructor)(p); continue }
    const rel = Math.abs(Number(curve.state.poolState.sqrtPrice.toString()) / Number(p) - 1)
    const amountOk = d === 'buy' ? r.spent - r.fee.total === BigInt(i) : r.sol === BigInt(o)
    if (rel < 1e-9) good++
    else { allOk = false; if (firstBad.length < 6) firstBad.push(`${m.token_symbol} ${d} rel=${rel.toExponential(2)} amountOk=${amountOk} t+${t - m.launched}s`) }
    curve.state.poolState.sqrtPrice = new (curve.state.poolState.sqrtPrice.constructor)(p)
  }
  if (allOk) marketsOk++
}
const recent = data.markets.filter(m => m.launched >= Date.parse('2026-10-01T00:00:00Z') / 1000).length
console.log(`markets launched since Oct 1: ${recent}`)
console.log(`${good}/${total} trades reproduce the recorded price (±1e-9); ${marketsOk} markets fully`)
console.log(firstBad.join('\n'))
