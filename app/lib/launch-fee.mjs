import { PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMarketConfigResolver } from '../../src/market-config.mjs'
import { launchFeeTerms, readFeeSchedule } from '../../src/launch-fee.mjs'
import { chain, configAddress } from './server.mjs'

// DBC config accounts cannot change after creation, so each approved config's fee schedule is read once per
// process. Copy about a launch fee is shown only when the market's (or the active) config really has one.
const READ_TIMEOUT_MS = 2_500
const schedules = new Map()

const withTimeout = promise => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(Error('DBC config read timed out')), READ_TIMEOUT_MS).unref?.())])

export async function configFeeSchedule(config, { connection = null } = {}) {
  const key = new PublicKey(config).toBase58()
  if (!schedules.has(key)) {
    const read = (async () => {
      const fixed = await new DynamicBondingCurveClient(connection ?? chain(), 'confirmed').state.getPoolConfig(key)
      if (!fixed) throw Error('DBC config is missing')
      return readFeeSchedule(fixed)
    })()
    schedules.set(key, read)
    read.catch(() => schedules.delete(key))
  }
  return withTimeout(schedules.get(key))
}

// Launch-fee copy terms for the config new launches use; null when flat, unconfigured or unreadable.
export async function activeLaunchFeeTerms(options = {}) {
  const config = configAddress()
  if (!config) return null
  try { return launchFeeTerms(await configFeeSchedule(config, options)) } catch { return null }
}

// Launch-fee copy terms for one canonical market's approved config; null when flat or unknown.
export async function marketLaunchFeeTerms(market, options = {}) {
  const config = configAddress()
  if (!config || !market?.mint || !market?.pool) return null
  try { return launchFeeTerms(await configFeeSchedule(createMarketConfigResolver(config)(market), options)) } catch { return null }
}
