// The operator bundle the PRODUCTION bootstrap (src/hooklab-production-bootstrap.mjs) loads, collected by the
// PRODUCTION collectors in their local dry-run mode (network {local: true}: a non-mainnet genesis on loopback RPC only):
//   - build 'native': bundle 3 (src/hooklab-production-native-bundle.mjs), which first refuses unless both programs hold
//     the reviewed native-SOL build, then pins the trimmed native ELFs and native IDLs;
//   - build 'bundle-2': the inclusive build the site ran before the upgrade (src/hooklab-production-operator-bundle.mjs).
// Both read every account through the stack's two HTTPS proxies (one trust domain, two labelled endpoints), with the
// same pins and refusals as production; the profile and dossier carry the local schemas and this validator's genesis.
// The one substitution: the collectors label a dry-run bundle 'repoing/local-operator-bundle/1', which production never
// accepts; the bootstrap is given it under the production label and accepts it only because local acceptance mode
// (HOOK_LOCAL_ACCEPTANCE, a pinned non-mainnet genesis) accepts the local profile and dossier schemas inside it.
// Collect it again after every governance stage: the config and governance pins are exact (config counters aside).
import { readFileSync } from 'node:fs'
import { Agent, request } from 'node:https'
import { Connection } from '@solana/web3.js'
import { collectProductionOperatorBundle } from '../../../src/hooklab-production-operator-bundle.mjs'
import { collectNativeProductionBundle } from '../../../src/hooklab-production-native-bundle.mjs'

/** A fetch for @solana/web3.js that trusts exactly the stack's throwaway certificate (web3.js on Node uses the global
 * fetch, which ignores httpAgent and cannot pick up a CA created after this process started). */
export function trustingFetch(agent) {
  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const req = request(url, { method: init.method ?? 'GET', agent, headers: Object.fromEntries(new Headers(init.headers ?? {})), timeout: 60_000 }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: { 'content-type': res.headers['content-type'] ?? 'application/json' } })))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(Error(`timeout ${url}`)))
    req.on('error', reject)
    if (init.body) req.write(init.body)
    req.end()
  })
}

const LOCAL_LABEL ='repoing/local-operator-bundle/1', PRODUCTION_LABEL = 'repoing/production-operator-bundle/1'

export async function collectLocalBundle({ genesisHash, providers, tlsCert, tradeTable, reviewer, treasury, build = 'native' }) {
  if (!['native', 'bundle-2'].includes(build)) throw Error(`unknown bundle build ${build}`)
  const agent = new Agent({ ca: readFileSync(tlsCert), keepAlive: true })
  const connections = providers.map(({ provider, origin }) => ({ provider, connection: new Connection(origin, { commitment: 'finalized', fetch: trustingFetch(agent) }) }))
  const trustDomains = providers.map(({ provider, origin }) => ({ provider, trustDomain: 'single-local-validator', origin }))
  const options = { connections, trustDomains, lookupTable: tradeTable, reviewer, treasury, approvalReference: 'DISPOSABLE-LOCAL-E2E-NOT-PRODUCTION',
    network: { genesisHash, local: true } }
  try {
    const bundle = build === 'native' ? (await collectNativeProductionBundle(options)).bundle : await collectProductionOperatorBundle(options)
    if (bundle.schema !== LOCAL_LABEL || bundle.genesisHash !== genesisHash) throw Error('the collector did not return a local dry-run bundle for this validator')
    return { ...bundle, schema: PRODUCTION_LABEL }
  } finally { agent.destroy() }
}
