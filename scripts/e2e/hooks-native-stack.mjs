#!/usr/bin/env node
// One command for the native-SOL release's real-browser e2e suite (tests/e2e/hooks-native), on a disposable LOCAL stack:
//
//   node scripts/e2e/hooks-native-stack.mjs test [e2e run args...]   # up, run the suite, down (exit code = the suite's)
//   node scripts/e2e/hooks-native-stack.mjs up                        # up and wait; Ctrl-C tears everything down
//   node scripts/e2e/hooks-native-stack.mjs suite STACK_JSON [args]   # run the suite against a stack that is already up
//
// It needs: solana-test-validator (HOOKS_E2E_VALIDATOR), the candidate native ELFs (HOOKLAB_NATIVE_ELF_DIR, pinned by
// src/hooklab-native-pins.mjs), PostgreSQL on 127.0.0.1:55432 (HOOKS_E2E_POSTGRES_URL), openssl, and Playwright's
// Chromium. It never touches mainnet, real keys, the macOS Keychain or production custody: every key is generated into
// a temporary root that teardown deletes, and telemetry is off (E2E_TELEMETRY_DISABLED=1, NEXT_TELEMETRY_DISABLED=1).
// HOOKS_E2E_KEEP=1 keeps the root (logs, bundle) after teardown; HOOKS_E2E_HOLD_ON_FAILURE=1 keeps a failed stack up.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO_ROOT } from './hooks-native/common.mjs'

process.env.E2E_TELEMETRY_DISABLED = '1'
process.chdir(REPO_ROOT)
const [command = 'test', ...rest] = process.argv.slice(2)
if (!['up', 'test', 'suite'].includes(command)) { console.error('usage: hooks-native-stack.mjs up | test [e2e run args...] | suite STACK_JSON [e2e run args...]'); process.exit(2) }

function runSuite(stateFile, cert, args) {
  const runner = spawn(process.execPath, [path.join(REPO_ROOT, 'node_modules/e2e/dist/cli/bin.js'), 'run', '--config', 'tests/e2e/hooks-native/e2e.config.ts', ...args], {
    cwd: REPO_ROOT, stdio: 'inherit',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, E2E_TELEMETRY_DISABLED: '1',
      ...(process.env.CI ? { CI: process.env.CI } : {}), HOOKS_E2E_STACK: stateFile, NODE_EXTRA_CA_CERTS: cert },
  })
  return new Promise(resolve => runner.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0))))
}

if (command === 'suite') {
  const [stateFile, ...args] = rest
  if (!stateFile) { console.error('suite needs the stack.json path that `up` printed'); process.exit(2) }
  process.exit(await runSuite(path.resolve(stateFile), JSON.parse(readFileSync(stateFile, 'utf8')).tls.cert, args))
}

const { up } = await import('./hooks-native/stack.mjs')
const started = Date.now()
const stack = await up({ keep: process.env.HOOKS_E2E_KEEP === '1' }).catch(error => { console.error(`stack failed: ${error.stack ?? error.message}`); process.exit(1) })
let stopping = false
const stop = async code => { if (stopping) return; stopping = true; await stack.down(); process.exit(code) }
process.on('SIGINT', () => stop(130)); process.on('SIGTERM', () => stop(143))
stack.log(`stack up in ${((Date.now() - started) / 1000).toFixed(0)} s`)

if (command === 'up') {
  stack.log('Ctrl-C to tear down')
} else {
  const suiteStarted = Date.now()
  const code = await runSuite(stack.stateFile, stack.state.tls.cert, rest)
  stack.log(`suite exited ${code} after ${((Date.now() - suiteStarted) / 1000).toFixed(0)} s`)
  await stop(code)
}
