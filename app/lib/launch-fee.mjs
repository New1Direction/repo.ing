import { PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMarketConfigResolver } from '../../src/market-config.mjs'
import { launchFeeTerms, readFeeSchedule } from '../../src/launch-fee.mjs'
import { chain, configAddress } from './server.mjs'

// DBC config accounts cannot change after creation, so each approved config's fee schedule is read once per
// process. Copy about a launch fee is shown only when the market's (or the active) config really has one.
const READ_TIMEOUT_MS = 2_500
const states = new Map()

const withTimeout = promise => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(Error('DBC config read timed out')), READ_TIMEOUT_MS).unref?.())])

// The config account itself (one RPC read per config per process; a failed read is tried again next time). onRead: called when
// this call reads the chain, for callers that count their RPC requests (src/launch-guide.mjs).
export async function configState(config, { connection = null, onRead = () => {} } = {}) {
  const key = new PublicKey(config).toBase58()
  if (!states.has(key)) {
    onRead()
    const read = (async () => {
      const fixed = await new DynamicBondingCurveClient(connection ?? chain(), 'confirmed').state.getPoolConfig(key)
      if (!fixed) throw Error('DBC config is missing')
      return fixed
    })()
    states.set(key, read)
    read.catch(() => states.delete(key))
  }
  return withTimeout(states.get(key))
}

export async function configFeeSchedule(config, options = {}) {
  return readFeeSchedule(await configState(config, options))
}

// Launch-fee copy terms for the config new launches use; null when flat, unconfigured or unreadable.
export async function activeLaunchFeeTerms(options = {}) {
  const config = options.config ?? configAddress()
  if (!config) return null
  try { return launchFeeTerms(await configFeeSchedule(config, options)) } catch { return null }
}

// Launch-fee copy terms for one canonical market's approved config; null when flat or unknown.
export async function marketLaunchFeeTerms(market, options = {}) {
  const config = configAddress()
  if (!config || !market?.mint || !market?.pool) return null
  try { return launchFeeTerms(await configFeeSchedule(createMarketConfigResolver(config)(market), options)) } catch { return null }
}
