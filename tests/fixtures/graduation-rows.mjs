// Graduation columns as public readers load them (graduation_observations plus the graduation_events evidence hash),
// built with the production progress math so percentages, statuses and migration proofs match what the worker stores.
import { evidenceHash, graduationProgress } from '../../src/graduation-state.mjs'

export const SOL = 1_000_000_000n

// reserveSol/thresholdSol in whole SOL (or reserveLamports for exact values). age: how old the observation is at `now`.
// graduated: phase GRADUATED with durable migration evidence (proven: false drops the stored evidence hash), into `pool`.
// protocolLiquidityAdded: the monitor's verified protocol intents for that pool, as it stores them (left out when not given).
export function graduationColumns({ mint = 'Mint1111', reserveSol = 0n, reserveLamports, thresholdSol = 85n, age = 10_000, now = Date.now(),
  graduated = false, proven = true, rowStatus = 'VERIFIED', pool = `pool-${mint}`, protocolLiquidityAdded } = {}) {
  const at = new Date(now - age).toISOString()
  const reserve = reserveLamports ?? reserveSol * SOL, threshold = thresholdSol * SOL
  const observation = { ...graduationProgress(String(reserve), String(threshold), graduated), checkedAt: at, chainTime: at, mint, destination: null }
  if (graduated) {
    const migration = { signature: `sig-${mint}`, slot: 1, curve: `curve-${mint}`, config: 'config', mint, pool }
    Object.assign(observation, { curve: migration.curve, config: migration.config, migration, migrationHash: evidenceHash(migration),
      destination: { pool: migration.pool, url: `https://app.meteora.ag/dammv2/${migration.pool}` }, protocolLiquidityAdded })
  }
  return { status: rowStatus, observation: JSON.stringify(observation), error_code: rowStatus === 'VERIFIED' ? null : 'RPC_DISAGREEMENT',
    migration_evidence_hash: graduated && proven ? observation.migrationHash : null }
}
