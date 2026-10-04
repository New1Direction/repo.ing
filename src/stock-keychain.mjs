import { spawnSync } from 'node:child_process'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'
import { STOCK_EXECUTION_ERRORS as E, fail } from './stock-execution.mjs'

// The signing keys of stock collections and payouts, read from the operator's macOS Keychain only, exactly as
// scripts/create-stock-quote-config.mjs reads the partner key (`security find-generic-password -s <service> -a production -w`).
// Only scripts/stock-execute.mjs --execute imports this module; the worker never does, and never holds a key (SECURITY.md,
// docs/ARCHITECTURE.md). No environment variable is ever read for a key.
//   partner  repo.ing.dbc.partner: every stock config's fee claimer and the custody wallet (partner fees, payouts)
//   creator  repo.ing.dbc.creator: the platform creator, every pool's creator (creator fees)
export const STOCK_KEYCHAIN_SERVICES = Object.freeze({ partner: 'repo.ing.dbc.partner', creator: 'repo.ing.dbc.creator' })
export const STOCK_KEYCHAIN_ACCOUNT = 'production'
export const STOCK_KEYCHAIN_COMMAND = '/usr/bin/security'
// The longest one Keychain read may take, an unlock or access prompt included: a prompt nobody answers ends in KEY_MISSING.
export const STOCK_KEYCHAIN_TIMEOUT_MS = 120_000

// One role's signer. expected: the address it must be (the custody wallet for the partner); the creator is checked against each
// collection's reviewed signer. A failure names the service, never the value.
export function keychainSigner(role, { expected = null, spawn = spawnSync, timeoutMs = STOCK_KEYCHAIN_TIMEOUT_MS } = {}) {
  const service = STOCK_KEYCHAIN_SERVICES[role]
  if (!service) fail(E.INVALID_REQUEST, `Unknown signer role ${role}`)
  const result = spawn(STOCK_KEYCHAIN_COMMAND, ['find-generic-password', '-s', service, '-a', STOCK_KEYCHAIN_ACCOUNT, '-w'],
    { encoding: 'utf8', timeout: timeoutMs })
  if (result?.error?.code === 'ETIMEDOUT') {
    fail(E.KEY_MISSING, `${service} (account ${STOCK_KEYCHAIN_ACCOUNT}): the Keychain did not answer within ${timeoutMs / 1000} s (an unanswered prompt?)`)
  }
  if (result?.status !== 0) fail(E.KEY_MISSING, `${service} (account ${STOCK_KEYCHAIN_ACCOUNT}) is unavailable in the Keychain`)
  let signer
  try {
    const bytes = bs58.decode(String(result.stdout ?? '').trim())
    if (bytes.length !== 64) throw Error('length')
    signer = Keypair.fromSecretKey(bytes)
  } catch { fail(E.KEY_INVALID, `${service} does not hold a valid Solana secret key`) }
  if (expected && signer.publicKey.toBase58() !== expected) fail(E.SIGNER_MISMATCH, `${service} is not the expected ${role} wallet ${expected}`)
  return signer
}

// The operator script's signers, in two steps, so that no lock ever waits on the Keychain:
//   prepare(role)  reads the role's key, which may show an unlock or access prompt and so may wait up to STOCK_KEYCHAIN_TIMEOUT_MS.
//                  The pass (runStockExecution, src/stock-execution-job.mjs) calls it outside any lock, just before a collection
//                  or payout of that role runs. Each role is read once per run, and a failed read is kept, so a prompt nobody
//                  answered is not shown again for every transaction.
//   signer(role)   the executors' loadSigner, called under the market's lock: it returns the key prepare() read and never reads
//                  the Keychain itself. A role that was not prepared is KEY_MISSING.
export function keychainSigners({ expected = {}, spawn = spawnSync, timeoutMs = STOCK_KEYCHAIN_TIMEOUT_MS } = {}) {
  const read = new Map()
  const known = role => {
    const entry = read.get(role)
    if (entry.error) throw entry.error
    return entry.signer
  }
  return {
    prepare(role) {
      if (!read.has(role)) {
        try { read.set(role, { signer: keychainSigner(role, { expected: expected[role] ?? null, spawn, timeoutMs }) }) }
        catch (error) { read.set(role, { error }) }
      }
      return known(role)
    },
    signer(role) {
      if (!read.has(role)) fail(E.KEY_MISSING, `The ${role} key is read from the Keychain before the market's lock is taken, and it was not`)
      return known(role)
    },
  }
}
