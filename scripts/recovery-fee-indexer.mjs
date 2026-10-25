// Accounting only: no signer, collection, payout or general-worker entry point.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Connection } from '@solana/web3.js'
import { createDatabasePool } from '../src/database-pool.mjs'
import { createFeeAccrual } from '../src/fee-accrual.mjs'
import { createGraduatedFees, recordGraduatedFees, recordPlatformFees } from '../src/graduated-fees.mjs'
import { agreedFinalizedTransaction, agreeGraduation } from '../src/graduation-state.mjs'
import { createCustodyRecovery } from '../src/custody-recovery.mjs'
import { recoveryHistory } from './recovery-chart-indexer.mjs'

export async function indexRecoveryFees({ pool, connection, verification, config, market, custodyRecovery = null }) {
  if (!verification || new URL(connection.rpcEndpoint).hostname === new URL(verification.rpcEndpoint).hostname) throw Error('INDEPENDENT_RPC_REQUIRED')
  const accrual = createFeeAccrual({ pool, connection, verification, config, custodyRecovery, earlyAccess: null })
  const db = await pool.connect()
  let locked = false
  try {
    // Same pool lock as the existing indexer: an accidental overlapping process cannot move its cursor backward.
    locked = (await db.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [market.pool])).rows[0].locked
    if (!locked) return { busy: true }
    const { rows: [cursor] } = await db.query('select last_signature,last_slot::text from pool_fee_cursors where pool=$1', [market.pool])
    // With no cursor yet, read back to and including the launch transaction: it carries any first buy.
    const history = cursor?.last_signature
      ? await recoveryHistory(connection, verification, market.pool, cursor.last_signature, { pageSize: 1000, maxPages: 20 })
      : await recoveryHistory(connection, verification, market.pool, null, { pageSize: 1000, maxPages: 20, origin: market.launchSignature })
    let creditedBaseUnits = 0n
    for (const item of history) {
      if (!item.err) {
        const receipt = await agreedFinalizedTransaction(connection, verification, item.signature)
        if (receipt.slot !== item.slot) throw Error('FEE_SLOT_MISMATCH')
        const result = await accrual.recordTradeFees({ githubRepoId: market.repoId, signatures: [item.signature], allowNonSwap: true })
        creditedBaseUnits += result.creditedBaseUnits
      }
      // Advance only after evidence and inserts succeed. A crash in between repeats the same immutable
      // event keys, which the canonical writer compares/deduplicates; it never creates balancing credits.
      await db.query(`insert into pool_fee_cursors(pool,last_signature,last_slot) values($1,$2,$3)
        on conflict(pool) do update set last_signature=excluded.last_signature,last_slot=excluded.last_slot,updated_at=now()`,
      [market.pool,item.signature,item.slot])
    }
    return { repoId: market.repoId, transactions: history.length, creditedBaseUnits }
  } finally {
    let broken = false
    try { if (locked) await db.query('select pg_advisory_unlock(hashtextextended($1,0))', [market.pool]) }
    catch (error) { broken = true; throw error }
    finally { db.release(broken || undefined) }
  }
}

export async function runRecoveryFees(env = process.env, repoIds = []) {
  const bytes = readFileSync(new URL('../config/existing-market-custody.json', import.meta.url))
  if (createHash('sha256').update(bytes).digest('hex') !== env.ACCOUNTING_CUSTODY_SHA256) throw Error('CUSTODY_BINDING_REQUIRED')
  const custodyRecovery = JSON.parse(bytes)
  createCustodyRecovery(custodyRecovery)
  const url = new URL(env.RECOVERY_FEE_DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'repoing_fee_indexer' || url.pathname !== '/repoing_operational' ||
      url.searchParams.get('sslmode') !== 'verify-full' || url.searchParams.size !== 1) throw Error('ACCOUNTING_ROLE_REQUIRED')
  if (repoIds.some(id => !/^[1-9][0-9]*$/.test(id))) throw Error('INVALID_REPOSITORY')
  const connection = new Connection(env.SOLANA_RPC_URL, 'finalized')
  const verification = new Connection(env.SOLANA_VERIFICATION_RPC_URL, 'finalized')
  if (new URL(connection.rpcEndpoint).hostname === new URL(verification.rpcEndpoint).hostname) throw Error('INDEPENDENT_RPC_REQUIRED')
  if ((await Promise.all([connection, verification].map(c => c.getGenesisHash()))).some(g => g !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')) throw Error('NETWORK_MISMATCH')
  const pool = createDatabasePool({ connectionString: url.href, max: 3, statement_timeout: 15000, connectionTimeoutMillis: 15000 })
  try {
    if ((await pool.query('select current_user as role')).rows[0].role !== 'repoing_fee_indexer') throw Error('ACCOUNTING_ROLE_REQUIRED')
    // No bundles, stock or transfer-hook markets are silently admitted by this recovery lane.
    const { rows } = await pool.query(`select github_repo_id::text as "repoId",mint,pool,creator_wallet as "creatorWallet",
      launch_signature as "launchSignature",bundle_id as "bundleId" from markets where status='confirmed'
      and indexed_at is not null and launch_finality='finalized' and quote_asset_id is null
      and bundle_id is null and early_access_end is null and transfer_hook_program is null
      and (cardinality($1::bigint[])=0 or github_repo_id=any($1::bigint[])) order by github_repo_id`, [repoIds])
    const results = []
    const loadTransaction = (_rpc, signature) => agreedFinalizedTransaction(connection, verification, signature)
    const readers = [connection, verification].map(c => createGraduatedFees({ connection: c, config: env.DBC_CONFIG,
      db: pool, custodyRecovery, persistProof: false, loadTransaction }))
    for (const market of rows) {
      try {
        const result = await indexRecoveryFees({ pool, connection, verification, config: env.DBC_CONFIG, market, custodyRecovery })
        if (result.busy) { results.push({ repoId: market.repoId, status: 'BUSY' }); continue }
        const snapshots = await Promise.all(readers.map(r => r.read(market)))
        agreeGraduation(...snapshots.map(s => s && { evidence: s.evidence, partner: s.partner.evidence }))
        const db = await pool.connect()
        try {
          await db.query('begin')
          await db.query('select pg_advisory_xact_lock($1::bigint)', [market.repoId])
          const canonical = { ...market, githubRepoId: BigInt(market.repoId) }
          result.graduatedCredit = await recordGraduatedFees(db, canonical, snapshots[0])
          result.partnerCredit = await recordPlatformFees(db, canonical, snapshots[0]?.partner)
          await db.query('commit')
        } catch (error) { await db.query('rollback'); throw error }
        finally { db.release() }
        results.push({ ...result, status: 'INDEXED' })
      } catch (error) { results.push({ repoId: market.repoId, status: 'ERROR', error: /^[A-Z_]+$/.test(error.message) ? error.message : 'ACCOUNTING_EVIDENCE_UNAVAILABLE' }) }
    }
    return results
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = await runRecoveryFees(process.env, process.argv.slice(2))
    console.log(JSON.stringify(results, (_key, value) => typeof value === 'bigint' ? String(value) : value))
    if (results.some(r => r.status === 'ERROR')) process.exitCode = 1
  } catch { console.error('ACCOUNTING_RECOVERY_UNAVAILABLE'); process.exitCode = 1 }
}
