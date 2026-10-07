import BN from 'bn.js'
import { Rounding, getDeltaAmountBaseUnsigned, getDeltaAmountQuoteUnsigned, getNextSqrtPriceFromInput } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { BPS, RULES } from './early-access-hook.mjs'
import { FIXED_SUPPLY_BASE_UNITS } from './launch-buy.mjs'

// The two options of a contributor early access launch (docs/EARLY_ACCESS.md; owner decisions 2026-10-06 and 2026-10-07), set in
// the hook's mint config by init_mint and never changed: the fair ramp (one wallet holds at most 2% of the supply at the start,
// rising in a straight line to 10% while the curve sells, no limit from 50% curve progress on) and star unlocks (+0.5% of the
// supply per 100 GitHub stars the repository gains after the launch, at most +5%; star unlocks needs the fair ramp). Both only
// with the early access window, so a market's rules are 1, 3 or 7 (markets.hook_rules, migration 0061).
export const FAIR_RAMP = Object.freeze({ startBps: 200, endCapBps: 1000, progressPercent: 50 })
export const STAR_UNLOCKS = Object.freeze({ starStep: 100, starBonusBps: 50, starMaxBonusBps: 500 })
export const HOOK_RULE_SETS = Object.freeze([RULES.EARLY_ACCESS, RULES.EARLY_ACCESS | RULES.FAIR_RAMP,
  RULES.EARLY_ACCESS | RULES.FAIR_RAMP | RULES.STAR_UNLOCKS])

export function hookRules({ fairRamp = false, starUnlocks = false } = {}) {
  if (starUnlocks && !fairRamp) throw Error('Star unlocks needs the fair ramp')
  return RULES.EARLY_ACCESS | (fairRamp ? RULES.FAIR_RAMP : 0) | (starUnlocks ? RULES.STAR_UNLOCKS : 0)
}
// The options' terms as the launch form and the token page show them, in plain numbers (the form is a client component).
export const earlyAccessOptionTerms = () => ({
  ramp: { startPercent: FAIR_RAMP.startBps / 100, endPercent: FAIR_RAMP.endCapBps / 100, progressPercent: FAIR_RAMP.progressPercent,
    firstBuyMaxBaseUnits: (FIXED_SUPPLY_BASE_UNITS * BigInt(FAIR_RAMP.startBps) / BigInt(BPS)).toString() },
  stars: { step: STAR_UNLOCKS.starStep, bonusPercent: STAR_UNLOCKS.starBonusBps / 100, maxPercent: STAR_UNLOCKS.starMaxBonusBps / 100 },
})

// A stamped market's rules: hook_rules, or early access alone for a row read without it.
export const marketHookRules = market => market?.hookRules ?? (market?.earlyAccessEnd ? RULES.EARLY_ACCESS : null)
export const hasFairRamp = rules => Boolean(rules & RULES.FAIR_RAMP)
export const hasStarUnlocks = rules => Boolean(rules & RULES.STAR_UNLOCKS)

// The curve's base vault balance once its quote reserve reaches `percent` of the migration threshold: DBC's own price movement
// along the config's curve segments, without fees (they never enter the reserve).
export function vaultAtProgress(config, percent) {
  const supply = BigInt(config.preMigrationTokenSupply.toString())
  let quoteLeft = new BN(config.migrationQuoteThreshold.toString()).muln(percent).divn(100)
  let price = new BN(config.sqrtStartPrice.toString()), sold = new BN(0)
  for (const point of config.curve) {
    const liquidity = new BN(point.liquidity.toString()), upper = new BN(point.sqrtPrice.toString())
    if (liquidity.isZero() || quoteLeft.isZero()) break
    const segment = getDeltaAmountQuoteUnsigned(price, upper, liquidity, Rounding.Up)
    if (quoteLeft.gte(segment)) {
      sold = sold.add(getDeltaAmountBaseUnsigned(price, upper, liquidity, Rounding.Down))
      quoteLeft = quoteLeft.sub(segment)
      price = upper
      continue
    }
    sold = sold.add(getDeltaAmountBaseUnsigned(price, getNextSqrtPriceFromInput(price, liquidity, quoteLeft, false), liquidity, Rounding.Down))
    break
  }
  return supply - BigInt(sold.toString())
}

// The ramp settings init_mint takes (sent with the fair ramp only): the vault starts with the whole supply and the ramp ends where
// the curve is half sold by SOL. starsAtLaunch: the repository's star count read fresh at prepare (else the first report would
// give an instant bonus); without star unlocks every star field is 0, as the program requires.
export function rampSettings(config, { starUnlocks = false, starsAtLaunch } = {}) {
  if (starUnlocks && (!Number.isSafeInteger(starsAtLaunch) || starsAtLaunch < 0 || starsAtLaunch > 0xffffffff)) throw Error('Star count at launch is unreadable')
  return { startBps: FAIR_RAMP.startBps, endCapBps: FAIR_RAMP.endCapBps, vaultStart: BigInt(config.preMigrationTokenSupply.toString()),
    vaultEnd: vaultAtProgress(config, FAIR_RAMP.progressPercent),
    ...starUnlocks ? { starsAtLaunch, ...STAR_UNLOCKS } : { starsAtLaunch: 0, starStep: 0, starBonusBps: 0, starMaxBonusBps: 0 } }
}

// The most of the supply the launcher's first buy may take with the fair ramp: the ramp's start (the vault is full before it).
export const firstBuyCapBaseUnits = (config, rules) => hasFairRamp(rules)
  ? BigInt(config.preMigrationTokenSupply.toString()) * BigInt(FAIR_RAMP.startBps) / BigInt(BPS) : null

// Whether a decoded mint config holds exactly the options a market was stamped with and the settings rampSettings gives for its
// config (the star count at launch is whatever the launch read; a star field without star unlocks is 0).
export function rulesMatch(onChain, rules, config) {
  if (onChain.rules !== rules || !HOOK_RULE_SETS.includes(rules)) return false
  if (!hasFairRamp(rules)) return Object.values(onChain.ramp).every(value => BigInt(value) === 0n)
  const want = rampSettings(config, { starUnlocks: hasStarUnlocks(rules), starsAtLaunch: onChain.ramp.starsAtLaunch })
  return Object.entries(want).every(([field, value]) => BigInt(onChain.ramp[field]) === BigInt(value))
}
