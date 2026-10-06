import { bundleLaunchInstructions, policyValid } from './bundle-vault.mjs'

// Bundle launches (docs/BUNDLE_LAUNCH.md): the switch, the code gate and the settings the owner chose. Dark: no page, route
// or job builds a Bundle launch unless BUNDLE_LAUNCHES_ENABLED is exactly "true" and the code gate below is open as well.
// The program (programs/bundle-vault) is not deployed on mainnet and no platform account exists there.

// Off unless exactly "true".
export const bundleLaunchesEnabled = (env = process.env) => env.BUNDLE_LAUNCHES_ENABLED === 'true'

// The code's own readiness, independent of the switch. Closed: the site's raise pages and routes, the bundle tables, the
// vault agents and the fee-routing crank are not built yet, and the program has had no external audit or mainnet setup.
export const BUNDLE_LAUNCHES_READY = false
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

// The one entry point that builds a launch for the site. Refuses while launches are dark.
export function prepareBundleLaunch(options, env = process.env) {
  if (!bundleLaunchable(env)) throw Object.assign(Error(BUNDLE_LAUNCHES_DISABLED), { code: 'BUNDLE_LAUNCHES_DISABLED' })
  return bundleLaunchInstructions(options)
}
