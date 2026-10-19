// Graduation math against vectors from hook-lab's Rust core (tests/fixtures/hooklab-graduation-vectors.json, made by
// tests/fixtures/hooklab-graduation-vectors.rs), then the trade panel's graduation estimates built on it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buyOnCurve, curveParams, finalFillLamports, graduationOutcome, isReady, isqrt, maxSwapIn } from '../src/hooklab-graduation.mjs'
import { modelInclusiveCreatorQuote } from '../src/hooklab-inclusive-fee-quote.mjs'

const fixture = name => new URL(`./fixtures/${name}`, import.meta.url)
const vectors = JSON.parse(readFileSync(fixture('hooklab-graduation-vectors.json')))
const big = p => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, BigInt(v)]))
const opt = v => v === null ? null : BigInt(v)
const states = [...vectors.configs.flatMap(c => c.states.map(state => ({ state, creatorFeeBps: c.creatorFeeBps, graduationQuote: c.curve.graduationQuote, reserve: c.curve.reserveTokens, name: c.name }))),
  ...vectors.synthetic.map(s => ({ state: s.state, creatorFeeBps: s.creatorFeeBps, graduationQuote: s.graduationQuote, reserve: '1000000', name: 'synthetic' }))]
const marketOf = ({ state, creatorFeeBps, graduationQuote }) => ({ creatorFeeBps, graduationQuote, graduated: false, pool: state.pool })
// The core has no wallet cap; the website's model checks it, so vectors run with the cap lifted.
const model = (pool, side, amountIn, creatorFeeBps) => modelInclusiveCreatorQuote({ side, amountIn: BigInt(amountIn), minAmountOut: 1n, maxInput: BigInt(amountIn), creatorFeeBps,
  feeModel: 2, protocolShareBps: 2500, lpFeeBps: 0, flatProtocolFeeBps: 0, sniperWindowSecs: 0, sniperStartBps: 0, quoteHook: 'none', modules: 0, authorShareBps: 0, rules: 'none',
  rewards: false, recipientBaseBalance: 0n, maxWalletLifted: true, pool: big(pool),
  policy: { version: 2, feeModel: 2, protocolShareBps: 2500, creatorFeeBps, lpFeeBps: 0, initialSupply: 1_000_000_000_000_000n, capBps: 200 } })

test('the vectors carry their provenance: the core commit and the exact generator source next to them', () => {
  const p = vectors.provenance, source = readFileSync(fixture('hooklab-graduation-vectors.rs'))
  assert.equal(p.core.commit, '134e16de1aadeac921bb314284fd3fd181c86097')
  assert.equal(p.core.path, 'crates/bordrless-core/src/lib.rs')
  assert.equal(p.generator.path, 'tests/fixtures/hooklab-graduation-vectors.rs')
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${source.length}\0`), source])).digest('hex'), p.generator.gitBlob)
  assert.match(source.toString(), /lib\.rs blob 0a4ee467/)
  assert.equal(vectors.configs.length, 10); assert.ok(vectors.trades.length > 150)
})

test('curve parameters match the core for the canary and every launch size', () => {
  for (const c of vectors.configs) {
    const p = curveParams(c.supply, c.curveBps, c.virtualQuote)
    assert.deepEqual({ curveTokens: p.curveTokens, reserveTokens: p.reserveTokens, virtualBase: p.virtualBase, graduationQuote: p.graduationQuote }, big(c.curve), c.name)
  }
  const canary = vectors.configs.find(c => c.name === 'canary')
  assert.equal(BigInt(canary.curve.graduationQuote), 2n * BigInt(canary.virtualQuote), 'supply 1e15, 75% on the curve: the threshold is twice Vq')
  assert.equal(curveParams(1000n, 5000, 1n), null, 'half the supply on the curve leaves no curve')
  assert.equal(curveParams(1000n, 7500, 0n), null)
  for (const n of [0n, 1n, 2n, 3n, 15n, 16n, 17n, 1n << 64n, (1n << 100n) + 12345n, (1n << 128n) - 1n]) { const r = isqrt(n); assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, String(n)) }
})

test('max_swap_in, readiness and the exact final fill match the core in every state, including the edges', () => {
  let fills = 0, nulls = 0
  for (const s of states) {
    const p = big(s.state.pool), label = `${s.name}: ${s.state.label}`
    assert.equal(maxSwapIn(p.quoteReserve, p.virtualQuote, p.baseReserve, p.virtualBase), opt(s.state.maxSwapIn), label)
    assert.equal(isReady(p, s.graduationQuote), s.state.ready, label)
    const fill = finalFillLamports(marketOf(s))
    assert.equal(fill, s.state.finalFill === null ? null : BigInt(s.state.finalFill.amountIn), label)
    if (fill === null) { nulls++; continue }
    fills++
    const expected = s.state.finalFill.quote, after = buyOnCurve(marketOf(s), fill)
    assert.deepEqual(after.pool, big(expected.after), label)
    assert.ok(isReady(after.pool, s.graduationQuote), label)
    const before = buyOnCurve(marketOf(s), fill - 1n)
    assert.ok(!before || !isReady(before.pool, s.graduationQuote), `${label}: one lamport less does not graduate`)
  }
  assert.ok(fills >= 40 && nulls >= 10)
  assert.equal(finalFillLamports({ ...marketOf(states[0]), graduated: true }), null, 'a graduated coin has no fill')
  const synthetic = Object.fromEntries(vectors.synthetic.map(s => [s.state.label, s.state.finalFill?.amountIn ?? null]))
  assert.equal(synthetic['no exact fill'], null); assert.ok(synthetic['base runs out exactly'], 'a curve can also finish by selling its last base')
})

test('graduate: top-up, burn, locked LP and the open pool match the core, at an unchanged price', () => {
  let graduations = 0
  for (const s of states.filter(s => s.state.ready)) {
    const g = s.state.graduation, out = graduationOutcome(big(s.state.pool), BigInt(g?.reserveHolding ?? s.reserve)), label = `${s.name}: ${s.state.label}`
    if (g === null) { assert.equal(out, null, label); continue }
    graduations++
    assert.deepEqual({ topup: out.topup, burned: out.burned, lockedLp: out.lockedLp, lpSupply: out.lpSupply, priceBeforeWad: out.priceBeforeWad, priceAfterWad: out.priceAfterWad },
      { topup: BigInt(g.topup), burned: BigInt(g.burned), lockedLp: BigInt(g.lpLocked), lpSupply: BigInt(g.lpSupply), priceBeforeWad: BigInt(g.priceBeforeWad), priceAfterWad: BigInt(g.priceAfterWad) }, label)
    assert.deepEqual(out.pool, big(g.after), label)
    assert.ok(out.priceBeforeWad - out.priceAfterWad <= out.priceBeforeWad / 1_000_000n && out.priceAfterWad - out.priceBeforeWad <= out.priceBeforeWad / 1_000_000n, label)
  }
  assert.ok(graduations >= 13)
  const complete = states.find(s => s.name === 'canary' && s.state.label === 'complete'), pool = big(complete.state.pool)
  const donated = graduationOutcome(pool, BigInt(complete.reserve), { base: pool.baseReserve + 5n, quote: pool.quoteReserve + pool.protocolFeesQuote + 7n })
  assert.equal(donated.pool.baseReserve, graduationOutcome(pool, BigInt(complete.reserve)).pool.baseReserve + 5n, 'a donation to a vault becomes liquidity')
  assert.equal(donated.pool.quoteReserve, pool.quoteReserve + 7n)
  assert.equal(graduationOutcome(pool, 3n).topup, 3n, 'the top-up never exceeds what the reserve holds')
})

test('every inclusive quote before and after graduation matches the core, and refusals are refused', () => {
  let refused = 0
  for (const t of vectors.trades) {
    if (t.quote === null) { assert.throws(() => model(t.pool, t.side, t.amountIn, t.creatorFeeBps), /INSUFFICIENT_LIQUIDITY|CURVE_OVERFLOW|MIN_OUTPUT/, t.label); refused++; continue }
    const q = model(t.pool, t.side, t.amountIn, t.creatorFeeBps)
    assert.deepEqual({ gross: q.fees.grossQuote, platform: q.fees.platformQuote, creator: q.fees.creatorQuote, curveInput: q.curveInput, grossOutput: q.grossOutput, delivered: q.delivered },
      { gross: BigInt(t.quote.grossFee), platform: BigInt(t.quote.platformFee), creator: BigInt(t.quote.creatorFee), curveInput: BigInt(t.quote.curveInput),
        grossOutput: BigInt(t.quote.grossOutput), delivered: BigInt(t.quote.delivered) }, t.label)
    const after = big(t.quote.after)
    assert.deepEqual(q.after, { baseReserve: after.baseReserve, quoteReserve: after.quoteReserve, protocolFeesQuote: after.protocolFeesQuote }, t.label)
  }
  assert.ok(refused >= 20)
})
