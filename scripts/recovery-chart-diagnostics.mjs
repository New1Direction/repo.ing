// Diagnostic data has a separate, closed contract. Never serialize an Error or SQL.
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const sqlstates = new Set(['23502', '23503', '23505', '23514', '42501', '57014', '55P03', '25P03',
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01', '57P01', '57P02', '57P03',
  'P0001', '25006', '25P02', '42P01', '42703', '3F000', '22003', '22007', '22P02'])
const phases = new Set(['PREFLIGHT', 'CONNECT', 'GENESIS', 'LOCK_ACQUIRE', 'LOCK_RELEASE', 'READ',
  'HISTORY', 'TRANSACTION_READ', 'COMPUTE', 'GUARD', 'BEGIN', 'TRADE_INSERT', 'DAMM_INSERT',
  'CURSOR_UPSERT', 'CURSOR_TOUCH', 'COMMIT', 'ROLLBACK', 'GRADUATION', 'OBSERVATION_UPSERT',
  'WORKERS', 'COMPLETENESS', 'POOL_DRAIN', 'DISCONNECT', 'RELEASE', 'OTHER', 'FATAL'])
const operations = new Set(['NONE', 'CONNECT', 'SELECT', 'INSERT', 'UPDATE', 'TRANSACTION', 'LOCK', 'CLOSE', 'OTHER'])
const cleanupStates = new Set(['NOT_ATTEMPTED', 'SUCCEEDED', 'FAILED'])
const bound = n => Number.isFinite(n) ? Math.min(1000000, Math.max(0, Math.round(n))) : 0
const own = (value, key) => value && (typeof value === 'object' || typeof value === 'function')
  ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
const identity = value => typeof value === 'string' && Buffer.byteLength(value) <= 256
  ? createHash('sha256').update(value).digest('hex') : null
const nullableHash = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const integer = (value, min = 0, max = 1000000) => Number.isSafeInteger(value) && value >= min && value <= max

export function validateChartDiagnostic(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false
  const checks = {
    phase: v => phases.has(v), operation: v => operations.has(v), sqlstate: v => v === null || sqlstates.has(v),
    errorClass: v => ['POSTGRES', 'CONNECTION', 'TIMEOUT', 'OTHER'].includes(v),
    constraintHash: nullableHash, indexHash: nullableHash, tableHash: nullableHash,
    worker: v => integer(v, -1, 3), marketIndex: v => integer(v, -1), marketFirst: v => integer(v, -1), marketLast: v => integer(v, -1),
    rollback: v => cleanupStates.has(v), lockRelease: v => cleanupStates.has(v),
    elapsedMs: integer, queries: integer, rows: integer,
  }
  const keys = Reflect.ownKeys(value)
  return keys.length === Object.keys(checks).length && keys.every(k => typeof k === 'string' &&
    Object.hasOwn(checks, k) && checks[k](own(value, k)))
}

function queryClass(sql) {
  // Only classification uses SQL; no SQL/parameters are stored or hashed.
  const text = typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim().toLowerCase() : ''
  if (['begin', 'commit', 'rollback'].includes(text)) return [text.toUpperCase(), 'TRANSACTION']
  if (text.startsWith('select pg_try_advisory_lock(')) return ['LOCK_ACQUIRE', 'LOCK']
  if (text.startsWith('select pg_advisory_unlock(')) return ['LOCK_RELEASE', 'LOCK']
  for (const [prefix, phase, operation] of [
    ['insert into public.trade_events', 'TRADE_INSERT', 'INSERT'],
    ['insert into public.damm_trade_events', 'DAMM_INSERT', 'INSERT'],
    ['insert into recovery_charts.cursors', 'CURSOR_UPSERT', 'INSERT'],
    ['update recovery_charts.cursors', 'CURSOR_TOUCH', 'UPDATE'],
    ['insert into recovery_charts.observations', 'OBSERVATION_UPSERT', 'INSERT'],
    ['select ', 'READ', 'SELECT'],
  ]) if (text.startsWith(prefix)) return [phase, operation]
  return ['OTHER', 'OTHER']
}

export function createChartDiagnostics() {
  const scopes = new Map()
  let lockRelease = 'NOT_ATTEMPTED'
  return {
    lockRelease(value) { lockRelease = cleanupStates.has(value) ? value : 'NOT_ATTEMPTED' },
    scope(worker = -1) {
      if (!integer(worker, -1, 3) || scopes.has(worker)) throw Error('CHART_DIAGNOSTIC_SCOPE')
      const started = performance.now()
      let phase = 'PREFLIGHT', operation = 'NONE', marketIndex = -1, marketFirst = -1, marketLast = -1
      let failure, rollback = 'NOT_ATTEMPTED', queries = 0, rows = 0
      const scope = {
        phase(value) { phase = phases.has(value) ? value : 'OTHER'; operation = phase === 'CONNECT' ? 'CONNECT' : 'NONE' },
        market(index) { marketIndex = integer(index) ? index : -1; if (marketFirst === -1) marketFirst = marketIndex; marketLast = marketIndex },
        fail(error) {
          if (failure) return
          const code = own(error, 'code'), sqlstate = sqlstates.has(code) ? code : null
          failure = { phase, operation, sqlstate,
            errorClass: sqlstate ? 'POSTGRES' : ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
              ? 'CONNECTION' : code === 'ETIMEDOUT' ? 'TIMEOUT' : 'OTHER',
            constraintHash: identity(own(error, 'constraint')), indexHash: null, tableHash: identity(own(error, 'table')),
            worker, marketIndex, marketFirst, marketLast, elapsedMs: bound(performance.now() - started), queries, rows }
        },
        async query(db, ...args) {
          const previous = [phase, operation]
          ;[phase, operation] = queryClass(args[0]); queries = bound(queries + 1)
          try {
            const result = await db.query(...args)
            rows = bound(rows + (result?.rowCount ?? 0))
            if (phase === 'ROLLBACK') rollback = 'SUCCEEDED'
            return result
          } catch (error) {
            if (phase === 'ROLLBACK') rollback = 'FAILED'
            scope.fail(error); throw error
          } finally { [phase, operation] = previous }
        },
        wrap(client) {
          return {
            query: (...args) => scope.query(client, ...args),
            async connect() { phase = 'CONNECT'; operation = 'CONNECT'; try { return await client.connect() } catch (e) { scope.fail(e); throw e } },
            async end() { phase = 'DISCONNECT'; operation = 'CLOSE'; try { return await client.end() } catch (e) { scope.fail(e); throw e } },
            release() { try { return client.release() } catch (e) { phase = 'RELEASE'; operation = 'CLOSE'; scope.fail(e); throw e } },
          }
        },
        report() { return failure ? { ...failure, rollback, lockRelease } : null },
      }
      scopes.set(worker, scope)
      return scope
    },
    reports() {
      const reports = [...scopes.values()].map(s => s.report()).filter(Boolean)
      // An invalid diagnostic is omitted, never forwarded or used to alter writer behavior.
      return reports.filter(validateChartDiagnostic)
    },
  }
}
