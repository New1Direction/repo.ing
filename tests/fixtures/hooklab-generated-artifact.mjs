// Test fixtures only. Generated ELF-bearing JSON and executable artifacts stay outside tracked source and are
// supplied privately through environment variables. A test that needs an absent artifact skips with a reason that
// starts with ARTIFACT_SKIP_PREFIX and names the variable to set; scripts/hooks-release-check.sh fails on such skips.
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import nodeTest from 'node:test'

export const ARTIFACT_SKIP_PREFIX = 'missing private hook artifact'
const GENERATED_DIR = 'HOOKLAB_GENERATED_FIXTURE_DIR'
const INCLUSIVE_DIR = 'HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR'
const INCLUSIVE_TOKEN_ELF = 'HOOKLAB_INCLUSIVE_TOKEN_ELF'
const plans = { 'hooklab-max-wallet-buy-app-plan.json': 'buy-app-plan.json', 'hooklab-max-wallet-sell-app-plan.json': 'sell-app-plan.json' }
const maxWallet = new Set([...Object.keys(plans), 'hooklab-max-wallet-rust-vector.json', 'hooklab-max-wallet-buy-rust-vector.json', 'hooklab-max-wallet-sell-rust-vector.json'])
const custom = new Set(['hooklab-custom-rust-vector.json', 'hooklab-custom-launch-rust-vector.json'])
const inclusive = new Set(['inclusive-builder-vector.json', 'inclusive-post-launch-snapshot.json'])

function absoluteSetting(variable, kind) {
  const value = process.env[variable]
  if (!value || !isAbsolute(value)) throw Error(`${variable} must be an absolute ${kind}`)
  return value
}

// Unset: the ignored local copy beside baseUrl (default tests/fixtures/). Set: that absolute directory.
function generatedUrl(name, baseUrl = import.meta.url) {
  if (process.env[GENERATED_DIR] === undefined) return new URL(`./${name}`, baseUrl)
  return pathToFileURL(resolve(absoluteSetting(GENERATED_DIR, 'test-artifact directory'), plans[name] ?? name))
}

export function generatedMaxWalletArtifact(name, baseUrl) {
  if (!maxWallet.has(name)) throw Error('Unknown generated max-wallet artifact')
  return generatedUrl(name, baseUrl)
}

export function generatedCustomArtifact(name, baseUrl) {
  if (!custom.has(name)) throw Error('Unknown generated custom-hook artifact')
  return generatedUrl(name, baseUrl)
}

export function inclusiveGeneratedArtifact(name) {
  if (!inclusive.has(name)) throw Error('Unknown generated inclusive artifact')
  return resolve(absoluteSetting(INCLUSIVE_DIR, 'generated inclusive-vector directory'), name)
}

export const inclusiveTokenElfPath = () => absoluteSetting(INCLUSIVE_TOKEN_ELF, 'path to the rebuilt inclusive bordrless_token.so')

const skipReason = missing => missing.length > 0 && `${ARTIFACT_SKIP_PREFIX}: ${missing.join('; ')}`

// False when every named generated fixture is readable, else an explicit node:test skip reason.
export function missingGeneratedArtifacts(names, baseUrl) {
  const configured = process.env[GENERATED_DIR] !== undefined
  return skipReason(names.filter(name => !existsSync(custom.has(name) ? generatedCustomArtifact(name, baseUrl) : generatedMaxWalletArtifact(name, baseUrl)))
    .map(name => configured ? `${name} not found in ${GENERATED_DIR}=${process.env[GENERATED_DIR]}` : `${name} (set ${GENERATED_DIR})`))
}

export function missingInclusiveArtifacts(names, { tokenElf = false } = {}) {
  const missing = names.filter(name => !process.env[INCLUSIVE_DIR] || !existsSync(inclusiveGeneratedArtifact(name)))
    .map(name => process.env[INCLUSIVE_DIR] ? `${name} not found in ${INCLUSIVE_DIR}=${process.env[INCLUSIVE_DIR]}` : `${name} (set ${INCLUSIVE_DIR})`)
  if (tokenElf && !process.env[INCLUSIVE_TOKEN_ELF]) missing.push(`bordrless_token.so (set ${INCLUSIVE_TOKEN_ELF})`)
  else if (tokenElf && !existsSync(inclusiveTokenElfPath())) missing.push(`${INCLUSIVE_TOKEN_ELF}=${process.env[INCLUSIVE_TOKEN_ELF]} not found`)
  return skipReason(missing)
}

// For artifacts consumed by path from the environment (Rust harness binaries, ELF directories).
export function missingArtifactEnv(variables, description) {
  const unset = variables.filter(variable => !process.env[variable])
  return unset.length > 0 && `${ARTIFACT_SKIP_PREFIX}: set ${unset.join(', ')} (${description})`
}

export const combineSkips = (...reasons) => skipReason(reasons.filter(Boolean).map(reason => reason.slice(ARTIFACT_SKIP_PREFIX.length + 2)))

// node:test `test` that skips every case with the given reason; the plain `test` when nothing is missing.
export function testRequiring(skip) {
  if (!skip) return nodeTest
  return (name, options, fn) => typeof options === 'function' ? nodeTest(name, { skip }, options) : nodeTest(name, { ...options, skip }, fn)
}
