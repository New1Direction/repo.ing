// $5k USD launch pricing: exact lamport math, the two-source SOL price quorum, the bounds and the owner's words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { STANDARD_VIRTUAL_QUOTE, TARGET_USD_MICROS, VIRTUAL_QUOTE_BOUNDS, checkLaunchPricing, launchValues, launchVirtualQuote, ownerPricingLine,
  solUsdMicros, solUsdQuorum, formatSol, formatUsd, usdLaunchPricingEnabled } from '../src/hooklab-launch-pricing.mjs'

const reading = (source, usd) => ({ source, usd })

test('the opening virtual quote is ceil(1.125 x $5,000 / SOL price) in exact lamports', () => {
  assert.equal(launchVirtualQuote(105_630_000n), '53251917070', '53.25 SOL at $105.63 (owner decision example)')
  assert.equal(launchVirtualQuote(1_000_000_000n), '5625000000', 'SOL at $1,000 is exactly the lower bound')
  assert.equal(launchVirtualQuote(50_000_000n), '112500000000', 'SOL at $50 is exactly the upper bound')
  assert.equal(launchVirtualQuote(150_000_000n), '37500000000')
  assert.equal(launchVirtualQuote(105_630_001n), '53251916565', 'rounds 53,251,916,564.88 up, never down')
})

test('a quote outside the on-chain bounds is refused, never clamped', () => {
  assert.deepEqual(VIRTUAL_QUOTE_BOUNDS, { min: 5_625_000_000n, max: 112_500_000_000n })
  assert.throws(() => launchVirtualQuote(1_000_000_001n), /outside the launch config's 5\.625–112\.5 SOL bounds.*update the bounds on chain/i)
  assert.throws(() => launchVirtualQuote(49_999_999n), /outside the launch config's 5\.625–112\.5 SOL bounds/)
  assert.throws(() => launchVirtualQuote(0n), /SOL price/)
})

test('opening, graduation and raise follow the 1e15 / 7500 curve: 0.8889 Vq, 8 Vq and 2 Vq', () => {
  const v = launchValues('53251917070', 105_630_000n)
  assert.equal(v.virtualQuote, 53_251_917_070n)
  assert.equal(v.raiseLamports, 106_503_834_140n)
  assert.equal(v.graduationLamports, 426_015_336_560n)
  assert.equal(v.openingLamports, 47_335_037_395n)
  assert.equal(formatUsd(v.openingUsdMicros), '$5,000'); assert.equal(formatUsd(v.graduationUsdMicros), '$45,000'); assert.equal(formatUsd(v.raiseUsdMicros), '$11,250')
  assert.equal(formatSol(v.virtualQuote), '53.25 SOL'); assert.equal(formatSol(v.raiseLamports), '106.5 SOL'); assert.equal(formatSol(v.graduationLamports), '426.02 SOL')
  assert.equal(formatSol(1_000_000_000n), '1 SOL'); assert.equal(formatSol(5_625_000_000n), '5.63 SOL')
  assert.deepEqual(TARGET_USD_MICROS, { opening: 5_000_000_000n, raise: 11_250_000_000n, graduation: 45_000_000_000n }, 'the USD targets hold at any SOL price')
})

test('the SOL price is the median of the sources within 2% of the median of every answer, at least two kept', () => {
  const three = solUsdQuorum([reading('coingecko', 105.62), reading('jupiter', 105.63), reading('coinbase', 105.64)])
  assert.equal(three.solUsdMicros, '105630000')
  assert.deepEqual(three.sources, [{ source: 'coingecko', usdMicros: '105620000' }, { source: 'jupiter', usdMicros: '105630000' }, { source: 'coinbase', usdMicros: '105640000' }])
  assert.equal(solUsdQuorum([reading('coingecko', 100), reading('coinbase', 101)]).solUsdMicros, '100500000', 'two sources: their midpoint')
  assert.equal(solUsdQuorum([reading('jupiter', 100), reading('coinbase', 102)]).solUsdMicros, '101000000', 'each within 2% of their midpoint')
  // One outlier of three: dropped, still recorded and marked, and the two that agree set the price.
  const outlier = solUsdQuorum([reading('coingecko', 105.62), reading('jupiter', 120), reading('coinbase', 105.64)])
  assert.equal(outlier.solUsdMicros, '105630000')
  assert.deepEqual(outlier.sources, [{ source: 'coingecko', usdMicros: '105620000' }, { source: 'jupiter', usdMicros: '120000000', ignored: true }, { source: 'coinbase', usdMicros: '105640000' }])
  assert.equal(solUsdQuorum([reading('coingecko', 100), reading('jupiter', 100.5), reading('coinbase', 103)]).solUsdMicros, '100250000', '103 is 2.49% off the 100.50 median')
  // Two sources that disagree, two of three far apart, or a single answer: refused.
  assert.throws(() => solUsdQuorum([reading('coingecko', 100), reading('coinbase', 110)]),
    /SOL price sources disagree: fewer than two are within 2% of their median \(coingecko \$100\.00, coinbase \$110\.00\)/)
  assert.throws(() => solUsdQuorum([reading('coingecko', 90), reading('jupiter', 100), reading('coinbase', 110)]), /fewer than two are within 2% of their median/)
  assert.throws(() => solUsdQuorum([reading('coingecko', 105.63)]), /Only 1 SOL price source answered \(coingecko\); at least two must agree/)
  assert.throws(() => solUsdQuorum([]), /Only 0 SOL price sources answered/)
  assert.throws(() => solUsdQuorum([reading('coingecko', 100), reading('coingecko', 100)]), /independent/)
  assert.throws(() => solUsdQuorum([reading('coingecko', 100), reading('elsewhere', 100)]), /independent/)
  assert.equal(solUsdMicros(105.63), 105_630_000n); assert.throws(() => solUsdMicros(-1), /SOL price/); assert.throws(() => solUsdMicros(Number.NaN), /SOL price/)
})

test('a stored price is re-derived from its sources before anyone relies on it', () => {
  const quorum = solUsdQuorum([reading('coingecko', 105.62), reading('jupiter', 105.63), reading('coinbase', 105.64)])
  const pricing = { ...quorum, virtualQuote: launchVirtualQuote(BigInt(quorum.solUsdMicros)) }
  assert.deepEqual(checkLaunchPricing(pricing), { solUsdMicros: '105630000', sources: quorum.sources, virtualQuote: '53251917070' })
  assert.throws(() => checkLaunchPricing({ ...pricing, virtualQuote: '112500000000' }), /does not follow from its SOL price/)
  assert.throws(() => checkLaunchPricing({ ...pricing, solUsdMicros: '50000000' }), /does not match its sources/)
  assert.throws(() => checkLaunchPricing({ ...pricing, sources: pricing.sources.slice(0, 1) }), /at least two/)
  assert.throws(() => checkLaunchPricing(null), /missing/)
  // Ignored marks are re-derived too: a server cannot hide an outlier or drop an agreeing source.
  const outlier = solUsdQuorum([reading('coingecko', 105.62), reading('jupiter', 120), reading('coinbase', 105.64)]), priced = { ...outlier, virtualQuote: '53251917070' }
  assert.equal(checkLaunchPricing(priced).sources[1].ignored, true)
  assert.throws(() => checkLaunchPricing({ ...priced, sources: priced.sources.map(({ ignored, ...s }) => s) }), /does not match its sources/)
  assert.throws(() => checkLaunchPricing({ ...priced, sources: priced.sources.map((s, i) => i === 0 ? { ...s, ignored: true } : s) }), /does not match its sources/)
})

test('the owner sees the opening and graduation values in one line', () => {
  const quorum = solUsdQuorum([reading('coingecko', 105.62), reading('jupiter', 105.63), reading('coinbase', 105.64)])
  const line = ownerPricingLine({ ...quorum, virtualQuote: launchVirtualQuote(BigInt(quorum.solUsdMicros)) })
  assert.equal(line, 'Opens at ≈$5,000 (53.25 SOL virtual), graduates at ≈$45,000 / 106.5 SOL raised · SOL $105.63 (coingecko $105.62, jupiter $105.63, coinbase $105.64)')
  const outlier = solUsdQuorum([reading('coingecko', 105.62), reading('jupiter', 120), reading('coinbase', 105.64)])
  assert.match(ownerPricingLine({ ...outlier, virtualQuote: '53251917070' }), /· SOL \$105\.63 \(coingecko \$105\.62, jupiter \$120\.00 ignored, coinbase \$105\.64\)$/)
})

test('off unless HOOK_LAUNCH_USD_PRICING is exactly true; the standard quote stays 1 SOL', () => {
  assert.equal(STANDARD_VIRTUAL_QUOTE, '1000000000')
  for (const value of [undefined, '', 'TRUE', '1', 'yes']) assert.equal(usdLaunchPricingEnabled({ HOOK_LAUNCH_USD_PRICING: value }), false)
  assert.equal(usdLaunchPricingEnabled({ HOOK_LAUNCH_USD_PRICING: 'true' }), true)
})
