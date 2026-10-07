import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Rounding, getBaseTokenForSwap, getDeltaAmountQuoteUnsigned } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildEarlyAccessCurve } from '../src/launch-curve.mjs'
import { RULES } from '../src/early-access-hook.mjs'
import { FAIR_RAMP, HOOK_RULE_SETS, STAR_UNLOCKS, firstBuyCapBaseUnits, hookRules, marketHookRules, rampSettings, rulesMatch,
  vaultAtProgress } from '../src/early-access-rules.mjs'

// The fair ramp and star unlocks settings (docs/EARLY_ACCESS.md; owner decisions 2026-10-06 and 2026-10-07), from the early access
// curve the config is made with.
const curve = buildEarlyAccessCurve()
const config = { preMigrationTokenSupply: 1_000_000_000_000_000n, migrationQuoteThreshold: curve.migrationQuoteThreshold, sqrtStartPrice: curve.sqrtStartPrice,
  curve: curve.curve }
const SUPPLY = 1_000_000_000_000_000n

test('the rule sets: early access alone, with the fair ramp, with star unlocks too', () => {
  assert.deepEqual([hookRules(), hookRules({ fairRamp: true }), hookRules({ fairRamp: true, starUnlocks: true })], [...HOOK_RULE_SETS])
  assert.deepEqual([...HOOK_RULE_SETS], [RULES.EARLY_ACCESS, 3, 7])
  assert.throws(() => hookRules({ starUnlocks: true }), /needs the fair ramp/)
  assert.equal(marketHookRules({ earlyAccessEnd: new Date(), hookRules: 7 }), 7)
  assert.equal(marketHookRules({ earlyAccessEnd: new Date(), hookRules: null }), 1, 'stamped before 0061: early access alone')
  assert.equal(marketHookRules({ earlyAccessEnd: null, hookRules: null }), null)
})

// The ramp's end found another way: the sqrt price where the curve's SOL reaches half the threshold, by bisection, and the tokens
// sold up to it by the SDK's own getBaseTokenForSwap (the walk in vaultAtProgress uses getNextSqrtPriceFromInput instead).
test('the ramp\'s end agrees with the SDK\'s own count of tokens sold at half the threshold', () => {
  const points = curve.curve.filter(point => !new BN(point.liquidity.toString()).isZero())
  const quoteTo = price => {
    let lower = new BN(curve.sqrtStartPrice.toString()), total = new BN(0)
    for (const point of points) {
      const upper = BN.min(new BN(point.sqrtPrice.toString()), price)
      if (upper.lte(lower)) break
      total = total.add(getDeltaAmountQuoteUnsigned(lower, upper, new BN(point.liquidity.toString()), Rounding.Up))
      lower = new BN(point.sqrtPrice.toString())
    }
    return total
  }
  const target = new BN(curve.migrationQuoteThreshold.toString()).divn(2)
  let low = new BN(curve.sqrtStartPrice.toString()), high = new BN(points.at(-1).sqrtPrice.toString())
  while (high.sub(low).gtn(1)) { const middle = low.add(high).divn(2); if (quoteTo(middle).lte(target)) low = middle; else high = middle }
  const sold = BigInt(getBaseTokenForSwap(new BN(curve.sqrtStartPrice.toString()), low, curve.curve).toString())
  const walked = SUPPLY - vaultAtProgress(config, FAIR_RAMP.progressPercent)
  const gap = sold > walked ? sold - walked : walked - sold
  assert.ok(gap * 1_000_000n <= walked, `${sold} vs ${walked}: within one part in a million`)
})

test('the ramp ends where the curve is half sold by SOL: about 63% of the supply, 79% at migration', () => {
  assert.equal(vaultAtProgress(config, 0), SUPPLY)
  const half = vaultAtProgress(config, FAIR_RAMP.progressPercent), full = vaultAtProgress(config, 100)
  assert.ok(half > full && full > 0n)
  const soldPercent = vault => Number(SUPPLY - vault) / Number(SUPPLY) * 100
  assert.ok(Math.abs(soldPercent(half) - 63) < 0.5 && Math.abs(soldPercent(full) - 79) < 0.5, `${soldPercent(half)} ${soldPercent(full)}`)
  // The program's slope check: the limit rises at most one token per token sold.
  assert.ok(BigInt(FAIR_RAMP.endCapBps - FAIR_RAMP.startBps) * SUPPLY <= (SUPPLY - half) * 10_000n)
})

test('ramp settings: 2% to 10% over the half-sold curve; stars only with star unlocks, from the count at launch', () => {
  const ramp = rampSettings(config)
  assert.deepEqual(ramp, { startBps: 200, endCapBps: 1000, vaultStart: SUPPLY, vaultEnd: vaultAtProgress(config, 50), starsAtLaunch: 0, starStep: 0,
    starBonusBps: 0, starMaxBonusBps: 0 })
  assert.deepEqual(rampSettings(config, { starUnlocks: true, starsAtLaunch: 4321 }), { ...ramp, starsAtLaunch: 4321, ...STAR_UNLOCKS })
  assert.deepEqual({ ...STAR_UNLOCKS }, { starStep: 100, starBonusBps: 50, starMaxBonusBps: 500 })
  for (const stars of [-1, 1.5, 2 ** 32, undefined]) assert.throws(() => rampSettings(config, { starUnlocks: true, starsAtLaunch: stars }), /unreadable/)
  assert.equal(firstBuyCapBaseUnits(config, 3), SUPPLY * 2n / 100n)
  assert.equal(firstBuyCapBaseUnits(config, 1), null)
})

test('the evidence check: the stamped rules and the settings the config gives, nothing else', () => {
  const onChain = (rules, ramp) => ({ rules, ramp: Object.fromEntries(Object.entries(ramp).map(([field, value]) => [field, Number(value) === Number(value) ? value : 0])) })
  const zero = { startBps: 0, endCapBps: 0, vaultStart: 0n, vaultEnd: 0n, starsAtLaunch: 0, starStep: 0, starBonusBps: 0, starMaxBonusBps: 0 }
  const stars = rampSettings(config, { starUnlocks: true, starsAtLaunch: 12 })
  assert.equal(rulesMatch(onChain(1, zero), 1, config), true)
  assert.equal(rulesMatch(onChain(3, rampSettings(config)), 3, config), true)
  assert.equal(rulesMatch(onChain(7, stars), 7, config), true, 'whatever star count the launch read')
  assert.equal(rulesMatch(onChain(3, rampSettings(config)), 1, config), false, 'another rule set than stamped')
  assert.equal(rulesMatch(onChain(5, stars), 5, config), false, 'not an offered set')
  for (const field of ['startBps', 'endCapBps', 'vaultStart', 'vaultEnd', 'starStep', 'starBonusBps', 'starMaxBonusBps']) {
    const changed = { ...stars, [field]: typeof stars[field] === 'bigint' ? stars[field] + 1n : stars[field] + 1 }
    assert.equal(rulesMatch(onChain(7, changed), 7, config), false, field)
  }
  assert.equal(rulesMatch(onChain(1, { ...zero, startBps: 200 }), 1, config), false, 'a ramp field without the ramp')
})

test('migration 0061 is journaled after 0060, re-appliable, and its constraint name matches the schema', () => {
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  const at = entries.findIndex(entry => entry.tag === '0061_hook_rules')
  assert.deepEqual(entries[at], { idx: 61, version: '7', when: 1790910021000, tag: '0061_hook_rules', breakpoints: true })
  assert.equal(entries[at - 1].tag, '0060_bundles')
  assert.ok(entries.slice(at + 1).every(entry => entry.when > 1790910021000), 'later migrations come after it')
  const sql = readFileSync('drizzle/0061_hook_rules.sql', 'utf8')
  for (const statement of sql.split('--> statement-breakpoint').map(part => part.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
    assert.match(statement, /^(SET LOCAL|ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS|DO \$\$ BEGIN\s+IF NOT EXISTS|CREATE OR REPLACE FUNCTION)/, statement.slice(0, 80))
  }
  const names = [...sql.matchAll(/CONSTRAINT "(\w+)"|conname = '(\w+)'/g)].map(match => match[1] ?? match[2])
  assert.deepEqual([...new Set(names)], ['markets_hook_rules_check'])
  assert.ok(readFileSync('src/db/schema.mjs', 'utf8').includes("'markets_hook_rules_check'"))
})
