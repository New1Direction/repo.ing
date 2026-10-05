import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// scripts/run-worker.mjs with the stock execution flags unset behaves exactly as it did before the job existed. The worker runs
// once (--once) against a fresh PostgreSQL database holding a SOL market and a stock-paired market, and an in-process JSON-RPC
// server that answers every call with an error and records it; then it runs again from a copy of the script with exactly the
// job's lines removed. Their output lines, exit codes and RPC calls must be identical, and no transaction is ever sent. With a
// flag on, the job only recovers rows the operator's script signed, with no key: idle, it changes nothing either; with a row
// pending, it checks the network first and fails the run loudly on this refusing RPC.
const DB = 'repoing_stock_execution_worker_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const ROOT = new URL('..', import.meta.url)
const META = quoteAssetById('meta-xstock')

// The job's lines in scripts/run-worker.mjs, exactly. If they change, change them here too: this test removes them to rebuild
// the worker as it was without the job.
const JOB_LINES = [
  "import { createStockExecutionJob, STOCK_EXECUTION_INTERVAL_MS, stockExecutionLoud } from '../src/stock-execution-job.mjs'\n",
  `// Stock-pair fee collections and launcher payouts (docs/STOCK_QUOTES.md, "Execution (off by default)"): the worker only finishes
// rows scripts/stock-execute.mjs already signed (settle, rebroadcast, abort) and holds no key. null, so nothing is built, read or
// printed, unless STOCK_COLLECTIONS_EXECUTION_ENABLED or STOCK_LAUNCHER_PAYOUTS_ENABLED is 'true'.
const stockExecution=createStockExecutionJob({pool,config,connect:()=>({connection:graduationRPC(rpc),verification:process.env.GRADUATION_VERIFICATION_RPC_URL
  ?graduationRPC(process.env.GRADUATION_VERIFICATION_RPC_URL):null})})
let stockExecutionTask=null,nextStockExecutionCheck=0
async function observeStockExecution(){
  try{
    const r=await meter.track('stockExecution',()=>stockExecution.runOnce())
    if(r.collections.length||r.payouts.length)console.log(JSON.stringify({stockExecution:r}))
    if(stockExecutionLoud(r))process.exitCode=1
  }catch(error){console.log(JSON.stringify({stockExecutionError:String(error?.message??'STOCK_EXECUTION_UNAVAILABLE').slice(0,200)}));process.exitCode=1}
}
`,
  `    if(stockExecution){
      if(once)await observeStockExecution()
      else if(!stockExecutionTask&&Date.now()>=nextStockExecutionCheck)
        stockExecutionTask=observeStockExecution().finally(()=>{nextStockExecutionCheck=Date.now()+STOCK_EXECUTION_INTERVAL_MS;stockExecutionTask=null})
    }
`,
  'if(stockExecutionTask)await stockExecutionTask;',
]

// The script with its imports made absolute, so a copy runs from any directory exactly as the original does.
function portable(source) {
  return source.replace(/from '(\.\.\/[^']+)'/g, (_, path) => `from '${new URL(path.slice(3), ROOT).href}'`)
    .replace(/from '([^.'/][^']*)'/g, (_, name) => `from '${import.meta.resolve(name)}'`)
}

// A JSON-RPC endpoint that refuses every call (as an unavailable provider would) and records the methods asked.
async function refusingRpc() {
  const methods = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const calls = [].concat(JSON.parse(body || '{}'))
      for (const call of calls) methods.push(call.method)
      const answers = calls.map(call => ({ jsonrpc: '2.0', id: call.id ?? null, error: { code: -32601, message: 'Method not found' } }))
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(JSON.parse(body || '{}')) ? answers : answers[0]))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, methods, close: () => new Promise(resolve => server.close(resolve)) }
}

const SEED = `insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values
    (94911145,'facebook','docusaurus','facebook/docusaurus',60000,9000,false,'2026-10-01T00:00:00Z'),
    (1296269,'octocat','Hello-World','octocat/Hello-World',3000,900,false,'2026-10-01T00:00:00Z');
  insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
      last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version) values
    (94911145,'confirmed','7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9','4HPc5MRfdDAvRG8puWi2fvwAT4whrkrGwz6zdwzTEw77',
      'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os','oapfTk8FG2np1vSoGANkbijWiQApHZMFAytSdCoass9','Docusaurus','DOCUSAURUS',
      'RSwSdP8jKmgTgVoKNbzP8N1yxmSHF4NRHYqxC1wLh57YnxWAxnYDg38boTPDVsiMk2g1sNMdExFzVifmyEuhDyN','H',1,1,'finalized',
      '2026-10-02T00:00:00Z','2026-10-02T00:00:00Z','meta-xstock','${META.mint}',1),
    (1296269,'confirmed','FezWPm3UEFa4nbF76D45V3gg9eZzhSxfw3tUES1Gr3o1','7EWrbxU7YpHthanStG9yF6KyHS77LBPH6f52ANJmL9rs',
      'F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4','oapfTk8FG2np1vSoGANkbijWiQApHZMFAytSdCoass9','Hello','HELLO',
      'ScTetvZxPRiLfchEixzMRHVeaZk4Cy1LvF2ZxjQnVAqHjd3wdM65zU6CbrjcBv8RVWNYHrzWgUWWrRKXYJLJHMP','H',1,1,'finalized',
      '2026-10-02T00:00:00Z','2026-10-02T00:00:00Z',null,null,null);`

// A payout the operator's script recorded and never finished.
const PENDING_PAYOUT = `insert into stock_launcher_payouts(github_repo_id,asset_id,quote_mint,wallet,amount,status,signature,signed_transaction,receipt)
  values (94911145,'meta-xstock','${META.mint}','AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os',5000000,'pending','PendingPayout','AA==','{}')`
const ON = { STOCK_COLLECTIONS_EXECUTION_ENABLED: 'true', STOCK_LAUNCHER_PAYOUTS_ENABLED: 'true' }

async function freshDatabase(extra = '') {
  const admin = new pg.Client({ connectionString: URL_.replace(new RegExp(`${DB}$`), 'postgres') })
  await admin.connect()
  try {
    await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.query(`create database ${DB}`)
  } finally { await admin.end() }
  const pool = new pg.Pool({ connectionString: URL_ })
  try { await migrate(drizzle(pool), { migrationsFolder: 'drizzle' }); await pool.query(SEED); if (extra) await pool.query(extra) } finally { await pool.end() }
}

// Volatile values only: wall-clock times, the usage line's elapsed seconds, and measured durations (graduationMs…).
const normalize = line => {
  let value
  try { value = JSON.parse(line) } catch { return line }
  return JSON.stringify(value, (key, field) => (key === 'seconds' || key.endsWith('Ms') ? 0 : typeof field === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(field) ? '<time>' : field))
}

// A fresh database, the script once, with only the variables a worker needs (never the developer's own environment).
async function runWorker(script, extraEnv = {}, extraSeed = '') {
  await freshDatabase(extraSeed)
  const rpc = await refusingRpc()
  try {
    const env = { PATH: process.env.PATH, DATABASE_URL: URL_, SOLANA_RPC_URL: rpc.url, DBC_CONFIG: '3Atsbq9N5EaCc9YWmqD2rUVedX4pqDe7hyk6JSyWRTrG',
      DEV_PULSE_ENABLED: 'false', ...extraEnv }
    const child = spawn(process.execPath, [script, '--once'], { cwd: new URL('.', ROOT).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const code = await new Promise(resolve => child.on('exit', resolve))
    return { code, lines: stdout.split('\n').filter(Boolean).map(normalize), stderr, methods: [...rpc.methods].sort() }
  } finally { await rpc.close() }
}

test('the worker with the stock execution flags unset is the worker without the job: same output, exit code and RPC calls', { timeout: 240_000 }, async () => {
  const source = await readFile(new URL('scripts/run-worker.mjs', ROOT), 'utf8')
  let without = source
  for (const lines of JOB_LINES) {
    assert.equal(without.split(lines).length, 2, `scripts/run-worker.mjs holds the job's lines exactly once:\n${lines}`)
    without = without.replace(lines, '')
  }
  assert.doesNotMatch(without, /stockexecution|STOCK_EXECUTION/i, 'every line of the job was removed')
  const dir = await mkdtemp(join(tmpdir(), 'repoing-worker-flags-'))
  try {
    const withJob = join(dir, 'run-worker-with-job.mjs'), withoutJob = join(dir, 'run-worker-without-job.mjs')
    await writeFile(withJob, portable(source))
    await writeFile(withoutJob, portable(without))
    const before = await runWorker(withoutJob)
    const after = await runWorker(withJob)
    assert.ok(before.lines.length >= 3, `the worker ran its jobs:\n${before.lines.join('\n')}\n${before.stderr}`)
    assert.deepEqual(after.lines, before.lines, 'identical output lines')
    assert.equal(after.code, before.code, 'identical exit code')
    assert.deepEqual(after.methods, before.methods, 'identical RPC calls')
    for (const run of [before, after]) {
      assert.ok(!run.methods.includes('sendTransaction'), 'nothing sent')
      assert.ok(!run.lines.some(line => /stockExecution/.test(line)))
    }
    // Explicitly 'false' is off too.
    const off = await runWorker(withJob, { STOCK_COLLECTIONS_EXECUTION_ENABLED: 'false', STOCK_LAUNCHER_PAYOUTS_ENABLED: 'false' })
    assert.deepEqual([off.lines, off.code, off.methods], [before.lines, before.code, before.methods])

    // On, with nothing pending: the job is one ledger query per kind and nothing else, so output and RPC calls are unchanged too.
    const idle = await runWorker(withJob, ON)
    assert.deepEqual([idle.lines, idle.code, idle.methods], [before.lines, before.code, before.methods])
    // On, with a payout the operator's script left pending: recovery checks the network before reading the row, and this RPC
    // refuses everything, so the job reports the error and fails the run. It sends nothing; it never plans, signs or loads a key.
    const pending = await runWorker(withJob, ON, PENDING_PAYOUT)
    const failure = pending.lines.map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.stockExecutionError)
    assert.ok(failure, `the job reported:\n${pending.lines.join('\n')}\n${pending.stderr}`)
    assert.equal(pending.code, 1)
    assert.ok(pending.methods.includes('getGenesisHash'), 'the network check ran')
    assert.ok(!pending.methods.includes('sendTransaction') && !pending.methods.includes('getMultipleAccounts'), 'nothing sent, nothing planned')
    assert.ok(!pending.lines.some(line => /stockExecution"/.test(line) && /WOULD_|COLLECT|PAY/.test(line)))
  } finally {
    await rm(dir, { recursive: true, force: true })
    const admin = new pg.Client({ connectionString: URL_.replace(new RegExp(`${DB}$`), 'postgres') })
    await admin.connect()
    try { await dropTestDatabase(admin, DB) } finally { await admin.end() }
  }
})
