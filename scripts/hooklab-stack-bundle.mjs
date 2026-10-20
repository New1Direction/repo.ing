#!/usr/bin/env node
// Read-only generator for our own stack's production bundle (new coins: open launches, native-SOL trading, claims),
// beside bundle 2 which stays as deployed for the legacy stack. Never signs or sends. The stack comes from hook-lab's
// independent-stack build output (--build-dir: ids/independent.json, ELFs, IDLs, ELF-HASHES.txt); every pin is computed
// from those files. It then reads every program, both configs and governances, the quote marker and the two frozen
// shared tables from both providers, refuses unless each equals its pin, and prints the preview and hashes as JSON.
//
// Local dry run (a disposable validator with the stack deployed at its IDs; the bundle carries the local schemas):
//   node scripts/hooklab-stack-bundle.mjs --build-dir DIR --local --rpc http://127.0.0.1:8899 --rpc2 http://localhost:8899 \
//     --trade-table ADDRESS --launch-table ADDRESS --reviewer ADMIN --treasury TREASURY [--upgrade-authority KEY] [--out FILE]
// Mainnet, after the owner's first-time setup (RPC URLs from HOOKLAB_PRODUCTION_RPC_PRIMARY_URL/_SECONDARY_URL; the
// owner's admin and treasury roles; --reviewed states that the ids file holds the owner's final keys):
//   node scripts/hooklab-stack-bundle.mjs --build-dir DIR --reviewed --trade-table ADDRESS --launch-table ADDRESS \
//     --approval-reference TEXT [--out FILE]
// The server installs it with HOOKLAB_STACK_BUNDLE_FILE, HOOKLAB_STACK_BUNDLE_SHA256 and HOOK_STACK_ADMIN_ADDRESS.
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Connection } from '@solana/web3.js'
import { MAINNET_ROLES } from '../src/hooklab-owner-driver/pins.mjs'
import { PRODUCTION_NETWORK } from '../src/hooklab-production-operator-bundle.mjs'
import { collectStackProductionBundle } from '../src/hooklab-production-stack-bundle.mjs'
import { stackFromIndependentBuild } from '../src/hooklab-stack-build.mjs'
// The reviewed providers, as scripts/hooklab-production-bundle-3.mjs lists them.
const KNOWN = [[/(^|\.)helius-rpc\.com$/, 'helius', 'helius'], [/(^|\.)publicnode\.com$/, 'publicnode', 'allnodes-publicnode'],
  [/(^|\.)rpcpool\.com$/, 'triton', 'triton-one'], [/^api\.mainnet-beta\.solana\.com$/, 'solana-labs', 'solana-foundation']]

const die = message => { console.error(message); process.exit(2) }
const { values: opt } = parseArgs({ options: { 'build-dir': { type: 'string' }, reviewed: { type: 'boolean', default: false }, local: { type: 'boolean', default: false },
  rpc: { type: 'string' }, rpc2: { type: 'string' }, 'trade-table': { type: 'string' }, 'launch-table': { type: 'string' }, reviewer: { type: 'string' }, treasury: { type: 'string' },
  'upgrade-authority': { type: 'string' }, 'approval-reference': { type: 'string' }, out: { type: 'string' } } })
if (!opt['build-dir'] || !opt['trade-table'] || !opt['launch-table']) die('Required: --build-dir DIR --trade-table ADDRESS --launch-table ADDRESS')
if (opt.out && existsSync(opt.out)) die(`${opt.out} exists; refusing to overwrite`)
if (!opt.local && opt['upgrade-authority']) die('--upgrade-authority is for a local dry run only; mainnet keeps the ids file\'s')
const connect = url => new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true })

async function localInputs() {
  if (!opt.rpc || !opt.rpc2 || !opt.reviewer || !opt.treasury) die('Local dry run requires --rpc URL --rpc2 URL --reviewer ADDRESS --treasury ADDRESS')
  const providers = ['local-a', 'local-b'], urls = [opt.rpc, opt.rpc2]
  const connections = urls.map((url, i) => ({ provider: providers[i], connection: connect(url) }))
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
  const { stack, idls } = stackFromIndependentBuild(opt['build-dir'], { reviewed: opt.reviewed, upgradeAuthority: opt['upgrade-authority'] ?? null })
  const inputs = opt.local ? await localInputs() : mainnetInputs()
  const bundle = await collectStackProductionBundle({ ...inputs, stack, idls, lookupTable: opt['trade-table'], launchTable: opt['launch-table'] })
  const bytes = Buffer.from(JSON.stringify(bundle)), dossier = JSON.parse(bundle.dossierJson), profile = JSON.parse(bundle.profile.json)
  if (opt.out) writeFileSync(opt.out, bytes, { flag: 'wx', mode: 0o644 })
  console.log(JSON.stringify({ mode: opt.local ? 'local-dry-run' : 'mainnet', schema: bundle.schema, genesisHash: bundle.genesisHash, observedSlot: bundle.observedSlot,
    stack: { id: stack.id, status: stack.status, build: stack.build.name, programs: profile.programs, upgradeAuthority: stack.upgradeAuthority },
    providers: bundle.profile.providers, programs: dossier.programs.map(({ role, elfSha256, elfLength, upgradeAuthority }) => ({ role, elfSha256, elfLength, upgradeAuthority })),
    economics: bundle.config.economics, reviewer: bundle.config.reviewer, profileSha256: bundle.config.profileSha256, dossierSha256: bundle.config.dossierSha256,
    bundleSha256: createHash('sha256').update(bytes).digest('hex'), out: opt.out ?? null }, null, 2))
} catch (error) { die(error?.code === 'PRODUCTION_BUNDLE_REFUSED' || error?.code === 'HOOKS_STACK_REFUSED' ? error.message : `Stack bundle not built: ${error.message}`) }
