#!/usr/bin/env node
// One command for the native-SOL release's real-browser e2e suite (tests/e2e/hooks-native), on a disposable LOCAL stack:
//
//   node scripts/e2e/hooks-native-stack.mjs test [e2e run args...]   # per mode: up, run its suites, down (exit 0 only if all pass)
//   node scripts/e2e/hooks-native-stack.mjs up                        # one mode up and wait; Ctrl-C tears everything down
//   node scripts/e2e/hooks-native-stack.mjs suite STACK_JSON [args]   # run suites against a stack that is already up
// HOOKS_E2E_MODES picks the modes (default native,legacy; see scripts/e2e/hooks-native/modes.mjs); `suite` without args
// runs the suites of the stack's own mode.
//
// It needs: solana-test-validator (HOOKS_E2E_VALIDATOR), the candidate native ELFs (HOOKLAB_NATIVE_ELF_DIR, pinned by
// src/hooklab-native-pins.mjs), PostgreSQL on 127.0.0.1:55432 (HOOKS_E2E_POSTGRES_URL), openssl, and Playwright's
// Chromium. It never touches mainnet, real keys, the macOS Keychain or production custody: every key is generated into
// a temporary root that teardown deletes, and telemetry is off (E2E_TELEMETRY_DISABLED=1, NEXT_TELEMETRY_DISABLED=1).
// Logs/public owner receipts are always archived under .amp/in/artifacts/hooks-native-runs (HOOKS_E2E_ARTIFACT_DIR overrides).
// HOOKS_E2E_KEEP=1 additionally retains scratch/keys for debugging, but still stops processes.
// HOOKS_E2E_HOLD_ON_FAILURE=1 explicitly holds a failed startup until Ctrl-C.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO_ROOT } from './hooks-native/common.mjs'

process.env.E2E_TELEMETRY_DISABLED = '1'
process.chdir(REPO_ROOT)
const [command = 'test', ...rest] = process.argv.slice(2)
if (!['up', 'test', 'suite'].includes(command)) { console.error('usage: hooks-native-stack.mjs up | test [e2e run args...] | suite STACK_JSON [e2e run args...]'); process.exit(2) }

let suiteRunner = null, suitePending = null
function runSuite(stateFile, cert, args) {
  const runner = spawn(process.execPath, [path.join(REPO_ROOT, 'node_modules/e2e/dist/cli/bin.js'), 'run', '--config', 'tests/e2e/hooks-native/e2e.config.ts', ...args], {
    cwd: REPO_ROOT, stdio: 'inherit', detached: command !== 'suite',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, E2E_TELEMETRY_DISABLED: '1',
      ...(process.env.CI ? { CI: process.env.CI } : {}), HOOKS_E2E_STACK: stateFile, NODE_EXTRA_CA_CERTS: cert },
  })
  suiteRunner = runner
  suitePending = new Promise((resolve, reject) => {
    runner.once('error', reject)
    runner.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
  }).finally(() => {
    // A crashed runner must not leave Chromium workers using a deleted root.
    if (command !== 'suite' && runner.pid) { try { process.kill(-runner.pid, 'SIGKILL') } catch { /* group gone */ } }
    suiteRunner = null
  })
  return suitePending
}

if (command === 'suite') {
  const [stateFile, ...args] = rest
  if (!stateFile) { console.error('suite needs the stack.json path that `up` printed'); process.exit(2) }
  const state = JSON.parse(readFileSync(stateFile, 'utf8')), { MODES } = await import('./hooks-native/modes.mjs')
  process.exit(await runSuite(path.resolve(stateFile), state.tls.cert, args.length ? args : MODES[state.mode ?? 'native'].suites))
}

const { up } = await import('./hooks-native/stack.mjs')
const { MODES, MODE_NAMES } = await import('./hooks-native/modes.mjs')
// Which modes `test` runs, each on its own fresh stack, in order (HOOKS_E2E_MODES, comma-separated). Self-serve joins the
// default once its owner-driver stages and website pieces have landed; until then it is run explicitly.
const modes = (process.env.HOOKS_E2E_MODES ?? 'native,legacy').split(',').map(m => m.trim()).filter(Boolean)
const bad = modes.find(m => !MODE_NAMES.includes(m))
if (bad) { console.error(`unknown mode ${bad}; known: ${MODE_NAMES.join(', ')}`); process.exit(2) }

let current = null, starting = null, stopping = null
const interruption = new AbortController()
const shutdown = code => stopping ??= (async () => {
  interruption.abort()
  try {
    // During startup `current` is not assigned yet; wait for its owned cleanup handle.
    await starting
    const runner = suiteRunner
    if (runner) {
      try { process.kill(-runner.pid, 'SIGTERM') } catch { /* group gone */ }
      const timer = setTimeout(() => { try { process.kill(-runner.pid, 'SIGKILL') } catch { /* group gone */ } }, 10_000)
      try { await suitePending } finally { clearTimeout(timer) }
    }
  } catch (error) { console.error(error) } finally {
    try { await current?.down({ status: 'interrupted' }) } catch (error) { console.error(error) }
    process.exit(code)
  }
})()
process.on('SIGINT', () => shutdown(130)); process.on('SIGTERM', () => shutdown(143))

async function bringUp(mode) {
  const started = Date.now()
  starting = up({ keep: process.env.HOOKS_E2E_KEEP === '1', mode, signal: interruption.signal }).catch(error => { console.error(`stack ${mode} failed: ${error.stack ?? error.message}`); return null })
  current = await starting
  current?.log(`stack up in ${((Date.now() - started) / 1000).toFixed(0)} s`)
  return current
}

if (command === 'up') {
  if (modes.length !== 1) { console.error('up brings up one stack: set HOOKS_E2E_MODES to one mode'); process.exit(2) }
  const stack = await bringUp(modes[0])
  if (stopping) await stopping
  if (!stack) process.exit(1)
  current.log('Ctrl-C to tear down')
} else {
  // Every requested mode runs; the exit code is non-zero if any stack or suite failed (a mode that cannot start fails).
  const results = []
  for (const mode of modes) {
    const stack = await bringUp(mode)
    if (stopping) await stopping
    if (!stack) { results.push([mode, 1]); continue }
    const suiteStarted = Date.now()
    let code = 1
    try {
      code = await runSuite(stack.stateFile, stack.state.tls.cert, rest.length ? rest : MODES[mode].suites)
      stack.log(`suite exited ${code} after ${((Date.now() - suiteStarted) / 1000).toFixed(0)} s`)
    } catch (error) { console.error(`suite ${mode} failed: ${error.message}`) }
    finally {
      if (stopping) await stopping
      await stack.down({ status: code === 0 ? 'passed' : 'failed' }); current = null
    }
    results.push([mode, code])
  }
  console.log(`modes: ${results.map(([mode, code]) => `${mode} ${code === 0 ? 'passed' : `FAILED (${code})`}`).join(', ')}`)
  process.exit(results.some(([, code]) => code !== 0) ? 1 : 0)
}
