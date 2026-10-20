// Shared helpers for the local native-SOL e2e stack (scripts/e2e/hooks-native-stack.mjs). Local only: loopback ports,
// a disposable root directory, no mainnet endpoint and no real key anywhere.
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const HOOKS_LOCAL_STATE = process.env.HOOKS_LOCAL_STATE ?? path.join(homedir(), 'Documents/ChatGPT/hooks-local-state')
// The candidate native-SOL ELFs (hook-lab e357fdf). Private: never copied into this public repository.
export const NATIVE_ELF_DIR = process.env.HOOKLAB_NATIVE_ELF_DIR ?? path.join(HOOKS_LOCAL_STATE, 'native-e357fdf')
export const VALIDATOR = process.env.HOOKS_E2E_VALIDATOR ?? '/opt/homebrew/bin/solana-test-validator'
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
// The fixed SOL/USD reading every price source answers with (scripts/e2e/hooks-native/offline-preload.mjs): $105.63, the
// owner's worked example, so the invite fixes a 53.251917070 SOL opening quote inside the on-chain bounds.
export const FIXED_SOL_USD = '105.63'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Polls `probe` until it returns a truthy value (returned) or the deadline passes. No fixed sleeps in callers. */
export async function waitFor(label, probe, { timeoutMs = 120_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try { const value = await probe(); if (value) return value } catch (error) { last = error }
    if (Date.now() > deadline) throw Error(`Timed out after ${timeoutMs} ms waiting for ${label}${last ? `: ${last.message}` : ''}`)
    await sleep(intervalMs)
  }
}

const portFree = port => new Promise(resolve => {
  const server = createServer(); server.unref(); server.once('error', () => resolve(false))
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
})
/** A run of `count` consecutive free loopback ports (the validator needs several next to each other). */
export async function freePortRange(count) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 30000)
    const free = await Promise.all(Array.from({ length: count }, (_, i) => portFree(base + i)))
    if (free.every(Boolean)) return base
  }
  throw Error(`No ${count} consecutive free loopback ports`)
}
export async function freePort() { return freePortRange(1) }

/** A line logger with a stage prefix and elapsed seconds, so a slow step is visible. */
export function stageLog(prefix = 'stack') {
  const started = Date.now()
  return (...parts) => console.log(`[${prefix} +${((Date.now() - started) / 1000).toFixed(1)}s]`, ...parts)
}
