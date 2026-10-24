// Chain reads and chart inserts only. Never run the general worker during recovery.
// Independent cursors must never advance the fee/accounting indexer's checkpoints.
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { Connection, PublicKey } from '@solana/web3.js'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { agreeGraduation, agreedFinalizedTransaction, evidenceJSON, readGraduationState } from '../src/graduation-state.mjs'
import { publicGraduation } from '../src/graduation-readiness.mjs'
import { canonicalTradeEvents } from '../src/trade-evidence.mjs'
import { dammSwapEvents } from '../src/damm-trades.mjs'
import { createMarketConfigResolver } from '../src/market-config.mjs'
import { chartMigration } from '../src/market-chart.mjs'

export async function recoveryHistory(connection, verification, address, boundary, { pageSize = 100, maxPages = 10 } = {}) {
  if (!verification || connection.rpcEndpoint === verification.rpcEndpoint) throw Error('INDEPENDENT_RPC_REQUIRED')
  if (!boundary) throw Error('CHART_BASELINE_REQUIRED')
  const walk = async rpc => {
    const result = []; let before
    for (let n = 0; n < maxPages; n++) {
      const page = await rpc.getSignaturesForAddress(new PublicKey(address), { limit: pageSize, ...(before ? { before } : {}) }, 'finalized')
      for (const { signature, slot, err } of page) {
        if (signature === boundary) return result.reverse()
        result.push({ signature, slot, err })
      }
      if (page.length < pageSize) throw Error('CHART_HISTORY_INCOMPLETE')
      before = page.at(-1).signature
    }
    throw Error('CHART_HISTORY_LIMIT')
  }
  return agreeGraduation(...await Promise.all([connection, verification].map(walk)))
}

export async function indexRecoveryMarket({ db, connection, verification, market, migration, config, legacyConfigs }) {
  const address = migration?.pool ?? market.pool
  const resolve = createMarketConfigResolver(config, legacyConfigs)
  const configKey = resolve(market) // even a migrated market must derive from an approved curve config
  const { rows: [cursor] } = await db.query('select signature from recovery_charts.cursors where pool=$1', [address])
  // The reviewed pre-recovery accounting checkpoint is only a starting boundary. Never update it here.
  const { rows: [baseline] } = cursor ? { rows: [] } : await db.query('select last_signature as signature from public.pool_fee_cursors where pool=$1', [address])
  const history = await recoveryHistory(connection, verification, address, cursor?.signature ?? baseline?.signature)
  const dbc = new DynamicBondingCurveClient(connection, 'finalized'), coder = new CpAmm(connection)._program.coder
  let inserted = 0
  for (const item of history) {
    const tx = item.err ? null : await agreedFinalizedTransaction(connection, verification, item.signature)
    if (tx && (tx.slot !== item.slot || (migration && BigInt(tx.slot) < BigInt(migration.slot)))) throw Error('CHART_SLOT_MISMATCH')
    const events = !tx ? [] : migration ? dammSwapEvents(tx, market, address, coder)
      : canonicalTradeEvents(tx, { ...market, signature: item.signature }, configKey, dbc)
    await db.query('begin')
    try {
      for (const e of events) {
        const result = migration ? await db.query(`insert into public.damm_trade_events
          (github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence,next_sqrt_price,trader,base_amount)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(signature,event_index) do nothing`,
        [market.repoId,address,item.signature,e.eventIndex,item.slot,e.tradedAt,e.quoteAmount,e.direction,evidenceJSON(e.evidence),e.nextSqrtPrice,e.trader,e.baseAmount])
          : await db.query(`insert into public.trade_events
          (pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price,trader)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(signature,event_index) do nothing`,
          [address,item.signature,e.eventIndex,item.slot,e.tradedAt,e.direction,e.inputBaseUnits,e.outputBaseUnits,e.nextSqrtPrice,e.trader])
        inserted += result.rowCount
      }
      await db.query(`insert into recovery_charts.cursors(pool,signature,slot,checked_at) values($1,$2,$3,now())
        on conflict(pool) do update set signature=excluded.signature,slot=excluded.slot,checked_at=now()`, [address,item.signature,item.slot])
      await db.query('commit')
    } catch (error) { await db.query('rollback'); throw error }
  }
  // A successful idle check is freshness evidence, not a fabricated trade timestamp.
  await db.query('update recovery_charts.cursors set checked_at=now() where pool=$1', [address])
  return { repoId: market.repoId, transactions: history.length, inserted }
}

export async function runRecoveryCharts(env = process.env) {
  const manifestBytes = readFileSync(new URL('../config/existing-market-custody.json', import.meta.url))
  if (createHash('sha256').update(manifestBytes).digest('hex') !== env.TRADING_CUSTODY_RECOVERY_SHA256) throw Error('CUSTODY_BINDING_REQUIRED')
  const custodyRecovery = JSON.parse(manifestBytes)
  const url = new URL(env.RECOVERY_CHART_DATABASE_URL)
  if (url.username !== 'repoing_chart_recovery' || url.searchParams.get('sslmode') !== 'verify-full' ||
    [...url.searchParams.keys()].some(k => k !== 'sslmode')) throw Error('CHART_ROLE_REQUIRED')
  const db = new pg.Client({ connectionString: url.toString(), application_name: 'repoing-chart-recovery',
    statement_timeout: 15000, query_timeout: 20000, connectionTimeoutMillis: 15000 })
  const connection = new Connection(env.SOLANA_RPC_URL, 'finalized'), verification = new Connection(env.SOLANA_VERIFICATION_RPC_URL, 'finalized')
  // Graduated markets need historical migration receipts that pruned RPCs cannot serve.
  const archiveVerification = env.SOLANA_ARCHIVE_VERIFICATION_RPC_URL
    ? new Connection(env.SOLANA_ARCHIVE_VERIFICATION_RPC_URL, 'finalized') : verification
  const providers = [...new Set([connection, verification, archiveVerification])]
  if ([verification, archiveVerification].some(c => new URL(connection.rpcEndpoint).hostname === new URL(c.rpcEndpoint).hostname)) throw Error('INDEPENDENT_RPC_REQUIRED')
  let locked = false, readers
  try {
    await db.connect()
    if ((await db.query('select current_user as role')).rows[0].role !== 'repoing_chart_recovery') throw Error('CHART_ROLE_REQUIRED')
    if ((await Promise.all(providers.map(c => c.getGenesisHash()))).some(hash => hash !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')) throw Error('NETWORK_MISMATCH')
    locked = (await db.query("select pg_try_advisory_lock(hashtext('recovery-charts')) as locked")).rows[0].locked
    if (!locked) return { busy: true }
    const { rows: markets } = await db.query(`select github_repo_id::text as "repoId",mint,pool,bundle_id as "bundleId",creator_wallet as "creatorWallet",
      early_access_end as "earlyAccessEnd",transfer_hook_program as "transferHookProgram"
      from public.markets where status='confirmed' and indexed_at is not null and launch_finality='finalized' and quote_asset_id is null`)
    const { rows: graduates } = await db.query('select * from public.graduation_events')
    // A slow serial RPC pass can exceed the observation freshness window. Each
    // reader owns its DB session so chart transactions never interleave; the
    // separate coordinator connection retains the process-wide advisory lock.
    readers = new pg.Pool({ connectionString: url.toString(), application_name: 'repoing-chart-reader', max: 4,
      statement_timeout: 15000, query_timeout: 20000, connectionTimeoutMillis: 15000 })
    const results = [], pending = [...markets]
    const work = async () => {
      const db = await readers.connect()
      try {
        while (pending.length) {
          const market = pending.shift()
          const result = { repoId: market.repoId }
          try {
            const graduation = graduates.find(g => String(g.github_repo_id) === market.repoId)
            const migration = chartMigration(market, graduation)
            const verifier = migration ? archiveVerification : verification
            Object.assign(result, await indexRecoveryMarket({ db, connection, verification: verifier, market, migration, config: env.DBC_CONFIG, legacyConfigs: env.DBC_LEGACY_CONFIGS }))
            const state = await readGraduationState({ db, connection, verification: verifier, market, config: env.DBC_CONFIG, custodyRecovery })
            if (state.migration) {
              const { rows: [volume] } = await db.query(`select coalesce(sum(quote_amount),0)::text as lamports
                from public.damm_trade_events where github_repo_id=$1 and pool=$2 and slot >= $3
                  and traded_at >= now()-interval '24 hours'`, [market.repoId,migration.pool,migration.slot])
              state.dammVolume24hLamports = volume.lamports
            }
            // Use the same freshness and immutable migration checks the public endpoint enforces.
            publicGraduation({ status: 'VERIFIED', observation: JSON.stringify(state), migration_evidence_hash: graduation?.evidence_hash })
            const { accountEvidence, positionEvidence, platform, partnerWallet, ...display } = state
            await db.query(`insert into recovery_charts.observations(github_repo_id,checked_at,observation) values($1,$2,$3)
              on conflict(github_repo_id) do update set checked_at=excluded.checked_at,observation=excluded.observation`, [market.repoId,state.checkedAt,JSON.stringify(display)])
            result.progress = state.phase
          } catch (e) { result.error = /^[A-Z_]+$/.test(e.message) ? e.message : 'CHART_READ_UNAVAILABLE' }
          results.push(result)
          await new Promise(r => setTimeout(r, 500))
        }
      } finally { db.release() }
    }
    await Promise.allSettled(Array.from({ length: Math.min(4, markets.length) }, work)).then(outcomes => {
      const failed = outcomes.find(outcome => outcome.status === 'rejected')
      if (failed) throw failed.reason
    })
    return { at: new Date().toISOString(), results }
  } finally {
    await readers?.end()
    if (locked) await db.query("select pg_advisory_unlock(hashtext('recovery-charts'))").catch(() => {})
    await db.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deadline = setTimeout(() => process.exit(1), 900000)
  try { console.log(JSON.stringify(await runRecoveryCharts())) }
  catch { console.error('CHART_RECOVERY_UNAVAILABLE'); process.exitCode = 1 }
  finally { clearTimeout(deadline) }
}
