#!/usr/bin/env node
// Runs the full test suite against a disposable PostgreSQL server and local validator.
// Usage: node scripts/ci/run-tests.mjs [--exclude=name ...] [name ...]   (no names: every tests/*.test.mjs)
// Requires PostgreSQL on 127.0.0.1:55432 (user postgres, trust or password "launchtest")
// and solana-test-validator on 127.0.0.1:8909 (scripts/ci/start-validator.sh).
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  ALIAS_PORTS, DEFAULT_ENV, DEFAULT_GROUP_DATABASES, PINNED_GROUPS, PRIMARY_PORT, ROLES,
} from './test-matrix.mjs'

const ADMIN_URL = `postgres://postgres:launchtest@127.0.0.1:${PRIMARY_PORT}/postgres`
const TEST_DIR = 'tests'
const COUNTERS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']

function isListening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

function listenAlias(port) {
  const server = net.createServer(client => {
    const upstream = net.connect({ host: '127.0.0.1', port: PRIMARY_PORT })
    client.pipe(upstream).pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.unref(); resolve(server) })
  })
}

// Expose the single PostgreSQL server on the other ports the selected tests pin. An alias
// port that is already taken is an error: it could be some other (non-disposable) server.
async function aliasPorts(groups) {
  const urls = groups.flatMap(group => [...group.databases, ...Object.values(group.env).filter(v => v.startsWith('postgres://'))])
  const needed = new Set(urls.map(url => Number(new URL(url).port)))
  for (const port of ALIAS_PORTS.filter(port => needed.has(port))) {
    if (await isListening(port)) {
      throw new Error(`127.0.0.1:${port} is already in use; the runner must own it to alias the disposable test server`)
    }
    await listenAlias(port)
  }
}

const quoteIdent = name => `"${name.replaceAll('"', '""')}"`
const databaseName = url => decodeURIComponent(new URL(url).pathname.slice(1))

async function withAdmin(work) {
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  try {
    return await work(admin)
  } finally {
    await admin.end()
  }
}

async function createRoles() {
  await withAdmin(async admin => {
    for (const role of ROLES) {
      const { rowCount } = await admin.query('select 1 from pg_roles where rolname = $1', [role])
      if (!rowCount) await admin.query(`create role ${quoteIdent(role)} login superuser`)
    }
  })
}

// Recreate the group's databases: migrated ones empty and at the latest migration,
// self-managed ones absent so the test can create them.
async function prepareGroup(group) {
  await withAdmin(async admin => {
    for (const url of group.databases) {
      await admin.query(`drop database if exists ${quoteIdent(databaseName(url))} with (force)`)
      if (group.selfManaged) continue
      const owner = decodeURIComponent(new URL(url).username) || 'postgres'
      await admin.query(`create database ${quoteIdent(databaseName(url))} owner ${quoteIdent(owner)}`)
    }
  })
  if (group.selfManaged) return
  for (const url of group.databases) {
    const pool = new pg.Pool({ connectionString: url })
    try {
      await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    } finally {
      await pool.end()
    }
  }
}

const matches = (file, name) => file === name || file === `${name}.test.mjs`

function buildGroups(argv) {
  const all = readdirSync(TEST_DIR).filter(name => name.endsWith('.test.mjs')).sort()
  const pinned = new Set(PINNED_GROUPS.flatMap(group => group.files.map(file => `${file}.test.mjs`)))
  for (const file of pinned) if (!all.includes(file)) throw new Error(`test-matrix references missing ${file}`)
  const excluded = argv.filter(arg => arg.startsWith('--exclude=')).map(arg => arg.slice('--exclude='.length))
  const only = argv.filter(arg => !arg.startsWith('--'))
  const selected = file => (!only.length || only.some(name => matches(file, name)))
    && !excluded.some(name => matches(file, name))
  const groups = [{ name: 'default', env: DEFAULT_ENV, unset: ['DATABASE_URL'], databases: DEFAULT_GROUP_DATABASES,
    files: all.filter(file => !pinned.has(file)) }]
  for (const group of PINNED_GROUPS) {
    groups.push({ name: group.files.join('+'), env: { ...DEFAULT_ENV, DATABASE_URL: group.databaseUrl }, unset: [],
      databases: [group.databaseUrl], selfManaged: Boolean(group.selfManaged),
      files: group.files.map(file => `${file}.test.mjs`) })
  }
  return groups
    .map(group => ({ ...group, files: group.files.filter(selected) }))
    .filter(group => group.files.length)
}

function parseTapSummary(file) {
  const summary = Object.fromEntries(COUNTERS.map(key => [key, 0]))
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^# (\w+) (\d+)$/.exec(line)
    if (match && match[1] in summary) summary[match[1]] = Number(match[2])
  }
  return summary
}

function runGroup(group, reportDir) {
  const tapFile = path.join(reportDir, `${group.name.replaceAll(/[^\w+-]/g, '_')}.tap`)
  const env = { ...process.env, ...group.env }
  for (const key of group.unset) delete env[key]
  const args = ['--test', '--test-concurrency=1',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${tapFile}`,
    ...group.files.map(file => path.join(TEST_DIR, file))]
  const target = group.env.DATABASE_URL ? ` DATABASE_URL=${group.env.DATABASE_URL}` : ''
  console.log(`\n=== ${group.name} (${group.files.length} files)${target}`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => resolve({ name: group.name, code, ...parseTapSummary(tapFile) }))
  })
}

async function main() {
  const groups = buildGroups(process.argv.slice(2))
  await aliasPorts(groups)
  await createRoles()
  const reportDir = mkdtempSync(path.join(tmpdir(), 'repoing-tests-'))
  const results = []
  for (const group of groups) {
    await prepareGroup(group)
    results.push(await runGroup(group, reportDir))
  }
  const totals = Object.fromEntries(COUNTERS.map(key => [key, results.reduce((sum, result) => sum + result[key], 0)]))
  console.log('\n=== summary')
  for (const result of results) {
    console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${result.name}: pass ${result.pass}, fail ${result.fail}, skipped ${result.skipped}`)
  }
  console.log(COUNTERS.map(key => `${key} ${totals[key]}`).join(', '))
  return results.every(result => result.code === 0) ? 0 : 1
}

main().then(code => process.exit(code), error => { console.error(error); process.exit(1) })
