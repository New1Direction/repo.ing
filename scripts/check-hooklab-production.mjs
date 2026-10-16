#!/usr/bin/env node
// Explicit read/reconciliation pass; never register this in the production worker automatically.
import { productionAccountDatabase, productionReadConfiguration } from '../app/lib/hooklab-production.mjs'
import { plainRecoveryJournal } from '../src/hooklab-plain-journal.mjs'
import { monitorPlainProduction } from '../src/hooklab-production-monitor.mjs'

let pool
try {
  const enabled = process.env.HOOKLAB_PRODUCTION_MONITOR_ENABLED === 'true'
  const evidence = enabled ? await productionReadConfiguration() : null
  pool = enabled ? productionAccountDatabase() : null
  const result = await monitorPlainProduction({ enabled, evidence, journal: pool ? plainRecoveryJournal(pool) : null })
  console.log(JSON.stringify({ hookLabProductionMonitor: result }))
  if (['unavailable', 'attention-required'].includes(result.status)) process.exitCode = 1
} catch {
  console.error(JSON.stringify({ hookLabProductionMonitor: { status: 'unavailable', executionEnabled: false,
    alerts: ['MONITOR_CONFIGURATION_OR_STORAGE_UNAVAILABLE'] } }))
  process.exitCode = 1
} finally { if (pool) await pool.end() }
