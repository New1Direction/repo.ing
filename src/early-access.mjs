import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { MAX_EARLY_ACCESS_SECONDS } from './early-access-hook.mjs'

// Contributor early access (docs/EARLY_ACCESS.md): its switches, its settings and the window a launcher may choose.
// Dark: the contributor wallet link (pages and API) exists only while EARLY_ACCESS_ENABLED is exactly "true", and no launch
// offers early access until the code gate below is opened as well.

// Off unless exactly "true": the contributor wallet page, its API and the GitHub sign-in for it answer 404.
export const earlyAccessEnabled = (env = process.env) => env.EARLY_ACCESS_ENABLED === 'true'

// The code's own readiness, independent of the switch. Closed: the launch (step 4), trades (5), claims (6) and graduation (7)
// for hook pools are not built yet. The step that finishes them opens it; EARLY_ACCESS_ENABLED must then be "true" as well.
export const EARLY_ACCESS_LAUNCHES_READY = false
export const earlyAccessLaunchable = (env = process.env) => EARLY_ACCESS_LAUNCHES_READY && earlyAccessEnabled(env)

// The window the launcher chooses (owner decision, 2026-10-05): 15 minutes to 24 hours. The hook program caps it at 24 hours.
export const EARLY_ACCESS_MIN_SECONDS = 15 * 60
export const EARLY_ACCESS_MAX_SECONDS = MAX_EARLY_ACCESS_SECONDS
// What the launch form offers.
export const EARLY_ACCESS_WINDOWS = Object.freeze([
  { seconds: 15 * 60, label: '15 minutes' },
  { seconds: 60 * 60, label: '1 hour' },
  { seconds: 6 * 60 * 60, label: '6 hours' },
  { seconds: 24 * 60 * 60, label: '24 hours' },
].map(Object.freeze))

// A market stamped for contributor early access (migration 0059): a transfer-hook pool with a Token-2022 mint on the early
// access config. Until the steps that handle hook pools ship, the site's SOL paths refuse or skip these markets.
export const isEarlyAccessMarket = market => (market?.earlyAccessEnd ?? null) !== null || (market?.transferHookProgram ?? null) !== null
// Any trade while EARLY_ACCESS_DBC_CONFIG is unset. With it, curve trades on the site and through Blinks go through
// swap2WithTransferHook (src/early-access-trade.mjs, steps 5d and 5e) and the graduated pool's through swap2 with token A on
// Token-2022 (src/canonical-damm-trade.mjs, step 7b).
export const EARLY_ACCESS_NOT_TRADABLE = 'Contributor early access markets are not tradable on the site yet.'
export const EARLY_ACCESS_NOT_CLAIMABLE = 'Contributor early access markets cannot be claimed on the site yet.'
// A graduated contributor early access market (DAMM v2 with a Token-2022 token): read, traded and claimed from step 7 on.
export const EARLY_ACCESS_GRADUATION_PENDING = 'EARLY_ACCESS_GRADUATION_PENDING'
// Owner decision (2026-10-07, step 7): a graduated early access market gets no liquidity deployment and no builder reinvest.
export const EARLY_ACCESS_NO_P3 = 'Early access markets are not eligible for liquidity deployment'
export const EARLY_ACCESS_NO_REINVEST = 'Early access markets are not eligible for builder reinvest'
// scripts/recover-expired-launch.mjs (the worker releases a proven expired early access launch itself).
export const EARLY_ACCESS_NO_MANUAL_RECOVERY = 'This is a contributor early access launch: manual recovery is not available yet. ' +
  'The worker releases it once two providers prove it expired without landing.'

export class EarlyAccessError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'EarlyAccessError'; this.status = status }
}

const WINDOW_ERROR = 'Choose an early access window from 15 minutes to 24 hours.'

// A whole number of seconds from 15 minutes to 24 hours (a number, or its digits as a string, as a form sends it).
export function earlyAccessWindow(seconds) {
  const value = typeof seconds === 'string' && /^\d{1,6}$/.test(seconds) ? Number(seconds) : seconds
  if (!Number.isSafeInteger(value) || value < EARLY_ACCESS_MIN_SECONDS || value > EARLY_ACCESS_MAX_SECONDS) throw new EarlyAccessError(WINDOW_ERROR)
  return value
}

// Settings (names in .env.example; values come with step 8). Each is null while unset; a value that is set but malformed
// throws, naming the variable and never its value.
function publicKeySetting(env, name) {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return null
  let key
  try { key = new PublicKey(raw.trim()) } catch { throw Error(`${name} must be a base58 public key`) }
  if (key.toBase58() !== raw.trim()) throw Error(`${name} must be a base58 public key`)
  return key
}

// The Meteora DBC config every early access pool is created on (create_config_with_transfer_hook, Token-2022).
export const earlyAccessDbcConfig = (env = process.env) => publicKeySetting(env, 'EARLY_ACCESS_DBC_CONFIG')
// A window's end in trade messages: "2026-10-07 12:15 UTC".
export const earlyAccessEndUtc = end => `${new Date(end).toISOString().slice(0, 16).replace('T', ' ')} UTC`
// For every path that opts in (traders, indexers, reconciliation): a malformed EARLY_ACCESS_DBC_CONFIG refuses early access markets
// only (logged by name), never every trade, index or claim.
// Logged once per process (paths read it per request).
const reportedSettings = new Set()
export function tradingEarlyAccessConfig(env = process.env, log = console.error) {
  try { return earlyAccessDbcConfig(env) } catch (error) {
    if (!reportedSettings.has(error.message)) { reportedSettings.add(error.message); log(`${error.message}; early access markets are not tradable`) }
    return null
  }
}
// The address lookup table early access launches (v0 transactions) are built with.
export const earlyAccessLookupTable = (env = process.env) => publicKeySetting(env, 'EARLY_ACCESS_LOOKUP_TABLE')

// The hook's oracle key (keeps allow lists current): base58 or a JSON byte array, like the other secret keys.
export function earlyAccessOracle(env = process.env) {
  const raw = env.EARLY_ACCESS_ORACLE_SECRET_KEY
  if (raw === undefined || raw.trim() === '') return null
  try {
    const value = raw.trim()
    const bytes = value.startsWith('[') ? JSON.parse(value) : [...bs58.decode(value)]
    if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw Error()
    return Keypair.fromSecretKey(Uint8Array.from(bytes))
  } catch { throw Error('EARLY_ACCESS_ORACLE_SECRET_KEY must be a 64-byte secret key (base58 or a JSON byte array)') }
}
