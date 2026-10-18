// Explicit server-owned local acceptance boundary. Production defaults stay mainnet.
import { PublicKey } from '@solana/web3.js'
const mainnet = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const LOCAL_PROFILE_SCHEMA = 'hook-lab/local-inclusive-max-wallet-builder-profile/1'
export const LOCAL_DOSSIER_SCHEMA = 'repoing/local-validator-observation/1'
const loopback = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
function httpsLoopback(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !loopback(url) || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw Error('Local acceptance requires an exact HTTPS loopback origin')
  return url
}
export function localAcceptanceNetwork(env = process.env) {
  if (env.HOOK_LOCAL_ACCEPTANCE !== 'true') return null
  if (typeof window !== 'undefined' || env.NODE_ENV !== 'development') throw Error('Local acceptance is development-server-only')
  const origin = httpsLoopback(env.HOOK_WALLET_IDENTITY_ORIGIN)
  const db = new URL(env.HOOK_WALLET_IDENTITY_DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !loopback(db) || db.search || db.hash || !/^\/hooks_local(?:_[a-z0-9_]+)?$/.test(db.pathname)) throw Error('A disposable loopback hooks_local database without query overrides is required')
  const genesisHash = env.HOOK_LOCAL_ACCEPTANCE_GENESIS
  if (new PublicKey(genesisHash).toBase58() !== genesisHash || genesisHash === mainnet) throw Error('A non-mainnet local genesis must be pinned')
  const endpoints = [env.HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY, env.HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY].map(value => httpsLoopback(value).origin)
  if (new Set(endpoints).size !== 2) throw Error('Two explicitly labeled local RPC proxies are required')
  return Object.freeze({ origin: origin.origin, genesisHash, endpoints, topology: 'single-local-validator-two-proxies' })
}
export function executionGenesis(env = process.env) { return localAcceptanceNetwork(env)?.genesisHash ?? mainnet }
export function assertLocalExecutionEndpoint(endpoint) {
  const local = localAcceptanceNetwork()
  if (local && !local.endpoints.includes(httpsLoopback(endpoint).origin)) throw Error('Non-local transaction endpoint is forbidden in local acceptance')
}
export function isLocalExecutionDossier(dossier) {
  return dossier?.schema === LOCAL_DOSSIER_SCHEMA && dossier.genesisHash === localAcceptanceNetwork()?.genesisHash
}
