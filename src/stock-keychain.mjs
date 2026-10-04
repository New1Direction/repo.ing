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

// One role's signer. expected: the address it must be (the custody wallet for the partner); the creator is checked against each
// collection's reviewed signer. A failure names the service, never the value.
export function keychainSigner(role, { expected = null, spawn = spawnSync } = {}) {
  const service = STOCK_KEYCHAIN_SERVICES[role]
  if (!service) fail(E.INVALID_REQUEST, `Unknown signer role ${role}`)
  const result = spawn('security', ['find-generic-password', '-s', service, '-a', STOCK_KEYCHAIN_ACCOUNT, '-w'], { encoding: 'utf8' })
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

// The loadSigner the executors take: each role read from the Keychain once per run.
export function keychainSigners({ expected = {}, spawn = spawnSync } = {}) {
  const signers = new Map()
  return role => {
    if (!signers.has(role)) signers.set(role, keychainSigner(role, { expected: expected[role] ?? null, spawn }))
    return signers.get(role)
  }
}
