import { MAX_RAISE_SECS, MAX_TARGET, MIN_DEPOSIT_FLOOR, MIN_TARGET, bundleLaunchInstructions, policyValid } from './bundle-vault.mjs'

// Bundle launches (docs/BUNDLE_LAUNCH.md): the switch, the code gate and the settings the owner chose. No page, route or job
// builds a Bundle launch unless BUNDLE_LAUNCHES_ENABLED is exactly "true" and the code gate below is open as well.
// The program (programs/bundle-vault) is deployed on mainnet with its platform account, bundle config and lookup table
// (docs/BUNDLE_LAUNCH.md, "Mainnet setup", done 2026-10-09).

// Off unless exactly "true".
export const bundleLaunchesEnabled = (env = process.env) => env.BUNDLE_LAUNCHES_ENABLED === 'true'

// The code's own readiness, independent of the switch. Open since the mainnet setup (owner's decision, 2026-10-09). Not built
// yet: an external audit, indexing of vault trades and fee routings, Bundle + early access. It gates what starts or funds a
// raise; reads, refunds and claims of bundles that already exist never wait for it (app/lib/bundle-api.mjs). Set it back to
// false to stop new raises and deposits without touching the switch.
export const BUNDLE_LAUNCHES_READY = true
export const bundleLaunchable = (env = process.env) => BUNDLE_LAUNCHES_READY && bundleLaunchesEnabled(env)
export const BUNDLE_LAUNCHES_DISABLED = 'Bundle launches are not available.'

// The owner's decisions (2026-10-06): 5% of a raise for operations, 80% of the partner fees (after the vault's rebate) to
// the backers, no vault trade before the 180 s launch fee ends. The vault policy values are starting points, not decisions.
export const BUNDLE_DEFAULTS = Object.freeze({
  opsBps: 500,
  backerBps: 8_000,
  launchCooldownSecs: 180,
  launchGraceSecs: 24 * 60 * 60,
  // The loosest policy a bundle may have (Platform.limits).
  limits: Object.freeze({ maxTradeBps: 500, maxDailyBuyBps: 2_000, maxDailySellBps: 300, floorBps: 10_000, gapSecs: 300 }),
  // A new bundle's policy: 2% of the vault per trade, 10% of its SOL bought or 1% of its tokens sold per day, never below cost,
  // 10 minutes between a buy and a sell.
  policy: Object.freeze({ maxTradeBps: 200, maxDailyBuyBps: 1_000, maxDailySellBps: 100, floorBps: 10_000, gapSecs: 600 }),
})
if (!policyValid(BUNDLE_DEFAULTS.limits) || !policyValid(BUNDLE_DEFAULTS.policy)) throw Error('Invalid bundle defaults')

// The raises the site opens (v1). The program allows more (targets up to 10,000 SOL, deadlines up to 30 days, deposits from
// 0.001 SOL); the site starts small because a raise is all or nothing and most bundles earn little at today's volume. A new
// bundle's vault policy is BUNDLE_DEFAULTS.policy.
export const BUNDLE_RAISE = Object.freeze({
  minTargetLamports: 1_000_000_000n,
  maxTargetLamports: 10_000_000_000n,
  defaultTargetLamports: 5_000_000_000n,
  minDepositLamports: 50_000_000n,
  deadlineDays: Object.freeze([1, 3, 7]),
  defaultDeadlineDays: 3,
})
if (BUNDLE_RAISE.minTargetLamports < MIN_TARGET || BUNDLE_RAISE.maxTargetLamports > MAX_TARGET || BUNDLE_RAISE.minDepositLamports < MIN_DEPOSIT_FLOOR ||
  BUNDLE_RAISE.minDepositLamports > BUNDLE_RAISE.minTargetLamports || Math.max(...BUNDLE_RAISE.deadlineDays) * 86_400 > MAX_RAISE_SECS) {
  throw Error('Bundle raise settings are outside the program\'s limits')
}

// The raise terms as the launch form shows them (plain values: lamports as digits, the shares as percents).
export const bundleFormSettings = () => ({
  minTargetLamports: String(BUNDLE_RAISE.minTargetLamports), maxTargetLamports: String(BUNDLE_RAISE.maxTargetLamports),
  defaultTargetLamports: String(BUNDLE_RAISE.defaultTargetLamports), minDepositLamports: String(BUNDLE_RAISE.minDepositLamports),
  deadlineDays: [...BUNDLE_RAISE.deadlineDays], defaultDeadlineDays: BUNDLE_RAISE.defaultDeadlineDays,
  opsPercent: `${BUNDLE_DEFAULTS.opsBps / 100}%`, backerPercent: `${BUNDLE_DEFAULTS.backerBps / 100}%`,
})

// The one entry point that builds a launch for the site. Refuses while launches are dark.
export function prepareBundleLaunch(options, env = process.env) {
  if (!bundleLaunchable(env)) throw Object.assign(Error(BUNDLE_LAUNCHES_DISABLED), { code: 'BUNDLE_LAUNCHES_DISABLED' })
  return bundleLaunchInstructions(options)
}
