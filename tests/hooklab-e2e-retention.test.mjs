import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startProcess } from '../scripts/e2e/hooks-native/process.mjs'
import { createRunCleanup } from '../scripts/e2e/hooks-native/retention.mjs'

test('completed cleanup stops its site, preserves evidence, and removes only its own scratch root', async t => {
  const parent = mkdtempSync(path.join(tmpdir(), 'hook-retention-test-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = mkdtempSync(path.join(parent, 'hooks-native-e2e-')), artifactsDir = path.join(parent, 'artifacts')
  mkdirSync(path.join(root, 'logs')); mkdirSync(path.join(root, 'ledger')); mkdirSync(path.join(root, 'keys'))
  writeFileSync(path.join(root, 'ledger', 'disposable'), 'scratch')
  writeFileSync(path.join(root, 'keys', 'synthetic-test-only'), 'not archival evidence')
  mkdirSync(path.join(root, 'owner-runs', 'stage'), { recursive: true })
  writeFileSync(path.join(root, 'owner-runs', 'stage', 'receipt-1234abcd.json'), '{"status":"finalized-success"}')
  const protectedFile = path.join(parent, 'active-run-and-release-evidence')
  writeFileSync(protectedFile, 'preserve')
  const site = startProcess('tiny site', process.execPath, ['-e', `
    console.log('ready'); setInterval(() => {}, 1000)
    process.on('SIGTERM', () => { console.log('final site log'); process.exit(0) })
  `], { cwd: parent, env: {}, logFile: path.join(root, 'logs', 'site.log') })
  t.after(() => site.stop())
  for (let i = 0; i < 100 && !site.lines.includes('ready'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(site.lines.includes('ready'))
  const down = createRunCleanup({ root, artifactsDir, cleanups: [{ name: 'site', run: site.stop }] })
  await Promise.all([down({ status: 'passed' }), down({ status: 'passed' })])
  assert.equal(site.alive(), false)
  assert.equal(existsSync(root), false)
  const archived = path.join(artifactsDir, path.basename(root))
  assert.match(readFileSync(path.join(archived, 'logs', 'site.log'), 'utf8'), /ready\nfinal site log\n/)
  assert.equal(JSON.parse(readFileSync(path.join(archived, 'run.json'))).status, 'passed')
  assert.equal(existsSync(path.join(archived, 'owner-runs', 'stage', 'receipt-1234abcd.json')), true)
  assert.equal(existsSync(path.join(archived, 'keys')), false)
  assert.equal(existsSync(path.join(archived, 'ledger')), false)
  assert.equal(readFileSync(protectedFile, 'utf8'), 'preserve')
})

test('failed runs clean scratch by default; explicit keep, stop failures and archive failures retain it', async t => {
  const parent = mkdtempSync(path.join(tmpdir(), 'hook-retention-test-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  for (const [scenario, retain] of [['failed', false], ['keep', true], ['stop-failed', true], ['archive-failed', true]]) {
    await t.test(scenario, async () => {
      const root = mkdtempSync(path.join(parent, 'hooks-native-e2e-'))
      mkdirSync(path.join(root, 'logs')); writeFileSync(path.join(root, 'logs', 'validator.log'), 'required failure log')
      const artifactsDir = path.join(parent, scenario)
      if (scenario === 'archive-failed') writeFileSync(artifactsDir, 'cannot archive into a file')
      let stopped = false
      const down = createRunCleanup({ root, artifactsDir, keep: scenario === 'keep', cleanups: [{ name: 'site', run: async () => {
        stopped = true
        if (scenario === 'stop-failed') throw Error('site still running')
      } }] })
      if (scenario.endsWith('-failed')) await assert.rejects(down({ status: 'failed' }))
      else await down({ status: 'failed' })
      assert.equal(stopped, true)
      assert.equal(existsSync(root), retain)
      if (scenario !== 'archive-failed') assert.equal(readFileSync(path.join(artifactsDir, path.basename(root), 'logs', 'validator.log'), 'utf8'), 'required failure log')
    })
  }
})

test('site workers are stopped even when their parent already exited; spawn failures also flush logs', async t => {
  const parent = mkdtempSync(path.join(tmpdir(), 'hook-retention-test-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const site = startProcess('exited site parent', process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
    console.log('worker ' + worker.pid); process.exit(0)
  `], { cwd: parent, env: {}, logFile: path.join(parent, 'site.log') })
  await site.exited
  const worker = Number(site.lines.find(line => line.startsWith('worker '))?.slice(7))
  assert.ok(Number.isInteger(worker) && worker > 0)
  const alive = () => { try { process.kill(worker, 0); return true } catch { return false } }
  t.after(() => { try { process.kill(worker, 'SIGKILL') } catch { /* gone */ } })
  assert.equal(alive(), true)
  await site.stop()
  for (let i = 0; i < 100 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(alive(), false)
  const missing = startProcess('missing executable', path.join(parent, 'not-installed'), [], { cwd: parent, env: {}, logFile: path.join(parent, 'missing.log') })
  assert.equal((await missing.exited).code, 1)
  await missing.stop()
  assert.match(readFileSync(path.join(parent, 'missing.log'), 'utf8'), /ENOENT/)
})
