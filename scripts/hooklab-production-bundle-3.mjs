#!/usr/bin/env node
// Read-only dry-run generator for production bundle 3: the native-SOL launch and swap builds (hook-lab feat/native-sol
// e357fdf) with bundle 2's gate, token, quote mint and menus. Never signs or sends. It previews launch and swap on both
// providers first and refuses unless each ProgramData holds the reviewed native build (trimmed ELF sha256 equal to
// NATIVE_ELF.*.trimmedSha256); before the mainnet upgrade it stops with "programs not upgraded yet". Then it builds the
// bundle (every pin, the gate, the configs and the trade table re-checked) and prints its preview and hashes as JSON.
//
// Local dry run: a disposable validator with the e357fdf ELFs at the mainnet program IDs. The bundle carries the local
// schemas and genesis, so production never accepts it:
//   node scripts/hooklab-production-bundle-3.mjs --local --rpc http://127.0.0.1:8899 --rpc2 http://localhost:8899 \
//     --trade-table ADDRESS --reviewer ADMIN --treasury TREASURY [--out FILE]
// Mainnet, after the owner's upgrade (RPC URLs from the environment, as for bundle 2:
// HOOKLAB_PRODUCTION_RPC_PRIMARY_URL, HOOKLAB_PRODUCTION_RPC_SECONDARY_URL):
//   node scripts/hooklab-production-bundle-3.mjs --trade-table ADDRESS --approval-reference TEXT [--out FILE]
// Without --out nothing is written.
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Connection } from '@solana/web3.js'
import { MAINNET_ROLES } from '../src/hooklab-owner-driver/pins.mjs'
import { PRODUCTION_NETWORK } from '../src/hooklab-production-operator-bundle.mjs'
import { collectNativeProductionBundle } from '../src/hooklab-production-native-bundle.mjs'
// The reviewed providers, as scripts/hooklab-production-bundle.mjs lists them (provider name and trust domain by host).
const KNOWN = [[/(^|\.)helius-rpc\.com$/, 'helius', 'helius'], [/(^|\.)publicnode\.com$/, 'publicnode', 'allnodes-publicnode'],
  [/(^|\.)rpcpool\.com$/, 'triton', 'triton-one'], [/^api\.mainnet-beta\.solana\.com$/, 'solana-labs', 'solana-foundation']]

const die = message => { console.error(message); process.exit(2) }
const { values: opt } = parseArgs({ options: { local: { type: 'boolean', default: false }, rpc: { type: 'string' }, rpc2: { type: 'string' },
  'trade-table': { type: 'string' }, reviewer: { type: 'string' }, treasury: { type: 'string' }, 'approval-reference': { type: 'string' }, out: { type: 'string' } } })
if (!opt['trade-table']) die('Required: --trade-table ADDRESS')
if (opt.out && existsSync(opt.out)) die(`${opt.out} exists; refusing to overwrite`)
const connect = url => new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true })

async function localInputs() {
  if (!opt.rpc || !opt.rpc2 || !opt.reviewer || !opt.treasury) die('Local dry run requires --rpc URL --rpc2 URL --reviewer ADDRESS --treasury ADDRESS')
  const providers = ['local-a', 'local-b'], urls = [opt.rpc, opt.rpc2]
  const connections = urls.map((url, i) => ({ provider: providers[i], connection: connect(url) }))
  // The collector refuses a mainnet genesis or a non-loopback endpoint here.
  const network = { genesisHash: await connections[0].connection.getGenesisHash(), local: true }
  return { connections, network, reviewer: opt.reviewer, treasury: opt.treasury, approvalReference: opt['approval-reference'] ?? 'LOCAL-DRY-RUN-NOT-PRODUCTION',
    trustDomains: urls.map((url, i) => ({ provider: providers[i], trustDomain: 'single-local-validator', origin: new URL(url).origin })) }
}
function mainnetInputs() {
  if (opt.rpc || opt.rpc2 || opt.reviewer || opt.treasury) die('Mainnet reads its RPC URLs from the environment and pins the owner roles; drop --rpc/--rpc2/--reviewer/--treasury or add --local')
  if (!opt['approval-reference']) die('Required: --approval-reference TEXT')
  const urls = [process.env.HOOKLAB_PRODUCTION_RPC_PRIMARY_URL, process.env.HOOKLAB_PRODUCTION_RPC_SECONDARY_URL]
  if (!urls.every(u => typeof u === 'string' && u.startsWith('https://'))) die('Set HOOKLAB_PRODUCTION_RPC_PRIMARY_URL and HOOKLAB_PRODUCTION_RPC_SECONDARY_URL (HTTPS) first.')
  const trustDomains = urls.map(url => {
    const { host, origin } = new URL(url), known = KNOWN.find(([pattern]) => pattern.test(host))
    if (!known) die(`Unreviewed RPC host ${host}; add it to the reviewed list first.`)
    return { provider: known[1], trustDomain: known[2], origin }
  })
  if (trustDomains[0].trustDomain === trustDomains[1].trustDomain) die('The two RPC URLs must be independent providers.')
  return { connections: urls.map((url, i) => ({ provider: trustDomains[i].provider, connection: connect(url) })), trustDomains, network: PRODUCTION_NETWORK,
    reviewer: MAINNET_ROLES.admin, treasury: MAINNET_ROLES.treasury, approvalReference: opt['approval-reference'] }
}

try {
  const inputs = opt.local ? await localInputs() : mainnetInputs()
  const { preview, bundle } = await collectNativeProductionBundle({ ...inputs, lookupTable: opt['trade-table'] })
  const bytes = Buffer.from(JSON.stringify(bundle)), dossier = JSON.parse(bundle.dossierJson), profile = JSON.parse(bundle.profile.json)
  if (opt.out) writeFileSync(opt.out, bytes, { flag: 'wx', mode: 0o644 })
  console.log(JSON.stringify({ mode: opt.local ? 'local-dry-run' : 'mainnet', schema: bundle.schema, genesisHash: bundle.genesisHash, observedSlot: bundle.observedSlot,
    providers: bundle.profile.providers, preview: preview.programs, sourceCommit: profile.sourceCommit, idlSha256: profile.idlSha256,
    programs: dossier.programs.map(({ role, elfSha256, elfLength, upgradeAuthority }) => ({ role, elfSha256, elfLength, upgradeAuthority })),
    profileSha256: bundle.config.profileSha256, dossierSha256: bundle.config.dossierSha256,
    bundleSha256: createHash('sha256').update(bytes).digest('hex'), out: opt.out ?? null }, null, 2))
} catch (error) { die(error?.code === 'PRODUCTION_BUNDLE_REFUSED' ? error.message : `Bundle 3 not built: ${error.message}`) }
