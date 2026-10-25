// No default execution. Suppress dependency logging before dynamic imports can read RPC endpoints.
import { readFileSync, statSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { parseArgs, canonicalJSON, digest, createRpcTape, openSnapshot, queryNames } from './boundary.mjs'
console.log = console.error = console.warn = console.info = console.debug = () => {}
let outputFile, deadline
try {
  const args = parseArgs(process.argv.slice(2))
  const env = Object.fromEntries(['RECOVERY_CHART_DATABASE_URL', 'RECOVERY_FEE_DATABASE_URL', 'SOLANA_RPC_URL',
    'SOLANA_VERIFICATION_RPC_URL', 'CHART_SOLANA_VERIFICATION_RPC_URL', 'SOLANA_ARCHIVE_VERIFICATION_RPC_URL',
    'DBC_CONFIG', 'DBC_LEGACY_CONFIGS', 'ACCOUNTING_CUSTODY_SHA256', 'TRADING_CUSTODY_RECOVERY_SHA256'].map(k => [k, process.env[k]]))
  // Dependency defaults must never discover unrelated credentials or capabilities in the caller's environment.
  for (const name of Object.keys(process.env)) delete process.env[name]
  const { computeShadow } = await import('./compute.mjs')
  if (args.mode === 'validate') process.stdout.write('{"status":"VALIDATED_NO_EXECUTION","networkCalls":0,"databaseWrites":0}\n')
  else {
    deadline = setTimeout(() => { process.stderr.write('SHADOW_DEADLINE\n'); process.exit(1) }, 900000)
    const started = performance.now()
    let packet, tape
    if (args.mode === 'capture') {
      // Refuse an existing destination before opening a DB or RPC connection.
      const fd = openSync(args.path, 'wx', 0o600); closeSync(fd); outputFile = args.path
      const connectionString = env[args.lane === 'chart' ? 'RECOVERY_CHART_DATABASE_URL' : 'RECOVERY_FEE_DATABASE_URL']
      const url = new URL(connectionString), role = args.lane === 'chart' ? 'repoing_chart_recovery' : 'repoing_fee_indexer'
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== role || url.pathname !== '/repoing_operational' ||
        url.searchParams.size !== 1 || url.searchParams.get('sslmode') !== 'verify-full') throw Error('SHADOW_DB_ROLE')
      const bytes = readFileSync(new URL('../../config/existing-market-custody.json', import.meta.url))
      if (createHash('sha256').update(bytes).digest('hex') !== env[args.lane === 'chart' ? 'TRADING_CUSTODY_RECOVERY_SHA256' : 'ACCOUNTING_CUSTODY_SHA256']) throw Error('SHADOW_CUSTODY')
      const endpoints = { primary: env.SOLANA_RPC_URL,
        verification: args.lane === 'chart' ? env.CHART_SOLANA_VERIFICATION_RPC_URL : env.SOLANA_VERIFICATION_RPC_URL,
        archive: env.SOLANA_ARCHIVE_VERIFICATION_RPC_URL }
      endpoints.archive ??= endpoints.verification
      if (Object.values(endpoints).some(e => new URL(e).protocol !== 'https:') ||
        ['verification', 'archive'].some(p => new URL(endpoints[p]).hostname === new URL(endpoints.primary).hostname)) throw Error('SHADOW_PROVIDER')
      packet = { version: 2, lane: args.lane, config: env.DBC_CONFIG, legacyConfigs: env.DBC_LEGACY_CONFIGS ?? '',
        custody: JSON.parse(bytes), db: {} }
      const snapshot = await openSnapshot({ connectionString }, args.lane)
      try {
        for (const name of queryNames(args.lane)) packet.db[name] = await snapshot.read(name)
        snapshot.assertSafe()
        packet.identity = snapshot.identity
      } finally { await snapshot.close() }
      packet.at = new Date().toISOString()
      tape = createRpcTape({ endpoints })
    } else {
      if (statSync(args.path).size > 96 * 1024 * 1024) throw Error('SHADOW_PACKET_LIMIT')
      const saved = JSON.parse(readFileSync(args.path, 'utf8'))
      if (saved.digest !== digest(saved.packet) || saved.packet.lane !== args.lane) throw Error('SHADOW_PACKET_MISMATCH')
      packet = saved.packet
      tape = createRpcTape({ entries: packet.rpc })
    }
    let rpcCalls = 0
    if (args.mode === 'capture') {
      // Capture per-market acquisition/validation clocks with real-time freshness checks.
      // Frozen replay uses those digest-bound clocks, never an end-of-cycle timestamp.
      await computeShadow(packet, tape, { capture: true })
      packet.rpc = tape.entries
      rpcCalls = tape.calls
      tape = createRpcTape({ entries: packet.rpc })
    }
    const result = await computeShadow(packet, tape)
    if (args.mode === 'capture') {
      const serialized = canonicalJSON({ packet, digest: digest(packet) })
      if (Buffer.byteLength(serialized) > 96 * 1024 * 1024) throw Error('SHADOW_PACKET_LIMIT')
      // Endpoints stay in memory. Also refuse accidental echo of any known credential or provider token.
      const secrets = Object.entries(env).filter(([k, v]) => /URL$/.test(k) && v).flatMap(([, v]) => {
        const u = new URL(v)
        return [v, decodeURIComponent(u.password), ...u.searchParams.values(), ...u.pathname.split('/').filter(s => s.length > 20)]
      }).filter(s => s.length >= 8 && s !== 'verify-full')
      if (secrets.some(secret => serialized.includes(secret))) throw Error('SHADOW_SECRET_DETECTED')
      writeFileSync(outputFile, serialized, { mode: 0o600 })
      outputFile = undefined
    }
    process.stdout.write(canonicalJSON({ status: 'SHADOW_COMPUTED', inputDigest: digest(packet), result,
      rpcCalls, elapsedMs: Math.round(performance.now() - started) }) + '\n')
  }
} catch (error) {
  process.stderr.write(error.message === 'SHADOW_ARGUMENTS' ? 'SHADOW_ARGUMENTS\n' : 'SHADOW_FAILED\n')
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  if (outputFile) unlinkSync(outputFile)
}
