// Run context: config, two verified readers, role map, compiler envelope and journal. Without --stack the driver runs
// the legacy stack (bundle 2 as deployed). With --stack FILE --stack-idls DIR it runs our own stack: its programs and
// quote marker (no bridge), its IDLs (ctx.abi, ctx.ix), its ELF pins (ctx.elf) and its profile envelope.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, roleAddresses, value } from './config.mjs'
import { makeReaders, verifyGenesis } from './rpc.mjs'
import { ELF, compilerEnvelope, loadArtifacts, loadStackArtifacts, stackCompilerEnvelope } from './artifacts.mjs'
import { instructionsFor } from './instructions.mjs'
import { openJournal } from './journal.mjs'
import { PROGRAMS, QUOTE_MINT, MAINNET_ROLES } from './pins.mjs'
import { hookPrograms } from '../hooklab-stack.mjs'
import { adminStages } from './stages/admin.mjs'
import { canaryStages } from './stages/canary.mjs'
import { status } from './stages/status.mjs'
import { tradeTable } from './stages/trade-table.mjs'
import { launchUsdBounds } from './stages/launch-bounds.mjs'
import { nativeLaunches } from './stages/native-launches.mjs'
import { openCreationStages } from './stages/open-creation.mjs'
import { LEGACY_ONLY_STAGES, STACK_ONLY_STAGES, STACK_STAGE_ORDER, stackStages } from './stages/stack.mjs'

export const STAGES = Object.freeze({ ...adminStages, ...canaryStages, 'trade-table': tradeTable, 'launch-usd-bounds': launchUsdBounds, 'native-launches': nativeLaunches,
  ...openCreationStages, ...stackStages, status })
export const STAGE_ORDER = Object.freeze(['status', 'launch-config', 'swap-config', 'grant', 'gate-finalize', 'fund', 'canary-prepare', 'alt',
  'canary-gates-open-creation', 'canary-launch', 'canary-gates-close-creation', 'canary-holdings', 'canary-buy', 'canary-sell', 'collect', 'trade-table', 'customer-grant',
  'open-launches', 'open-trading', 'close-trading', 'close-launches', 'launch-usd-bounds', 'native-launches', 'open-creation', 'launch-fee', 'launch-table', 'guardian-pause',
  'stack-verify', 'quote-marker', 'launch-config-init', 'swap-config-init', 'launch-governance-init', 'swap-governance-init', 'collect-native'])
export { STACK_STAGE_ORDER }
// A stage meant for the other stack is refused before anything is read.
export function assertStageForStack(stage, stack) {
  if (stack && LEGACY_ONLY_STAGES.has(stage)) throw Error(`${stage} runs on the legacy stack only (bridged coins and invites); our own stack has neither`)
  if (!stack && STACK_ONLY_STAGES.has(stage)) throw Error(`${stage} sets up our own stack: pass --stack FILE --stack-idls DIR`)
}

// The legacy stack's programs, marker, ABI, instruction builders and ELF pins (bundle 2 as deployed).
export const legacyChain = () => ({ stack: null, programs: PROGRAMS, quoteMint: QUOTE_MINT, abi: loadArtifacts(), elf: ELF, ix: instructionsFor(loadArtifacts) })
// Only after a verified non-mainnet genesis on two loopback RPCs: the repo compilers accept a
// local profile solely through this explicit acceptance scope (format-checked, never connected).
function enterLocalScope(genesis) {
  Object.assign(process.env, { NODE_ENV: 'development', HOOK_LOCAL_ACCEPTANCE: 'true', HOOK_LOCAL_ACCEPTANCE_GENESIS: genesis,
    HOOK_WALLET_IDENTITY_ORIGIN: 'https://127.0.0.1:19443', HOOK_WALLET_IDENTITY_DATABASE_URL: 'postgresql://127.0.0.1/hooks_local_owner_driver',
    HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY: 'https://127.0.0.1:19444', HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY: 'https://127.0.0.1:19445' })
}
// stackPath: a repoing/hooks-stack/1 descriptor (src/hooklab-stack.mjs); stackIdlDir: the stack build's IDLs.
function loadStack(stackPath, stackIdlDir, { localTest, roles }) {
  if (!stackPath) { if (stackIdlDir) throw Error('--stack-idls goes with --stack'); return null }
  const artifacts = loadStackArtifacts(JSON.parse(readFileSync(stackPath, 'utf8')), stackIdlDir)
  if (!localTest && artifacts.stack.status !== 'reviewed') throw Error('The stack is a placeholder (final program IDs not set): only --local-test runs it')
  if (roles.upgrade !== artifacts.stack.upgradeAuthority) throw Error(`The config's upgrade role ${roles.upgrade} is not the stack's upgrade authority ${artifacts.stack.upgradeAuthority}`)
  return artifacts
}
export async function createContext({ configPath, rpc, rpc2, localTest = false, runsRoot, journalRoot, options = {}, stackPath = null, stackIdlDir = null }) {
  const config = loadConfig(configPath)
  if (localTest !== (config.network === 'local-test')) throw Error(localTest ? '--local-test requires a config with network "local-test"' : 'A local-test config can only be used with --local-test')
  const roles = roleAddresses(config), stack = loadStack(stackPath, stackIdlDir, { localTest, roles })
  const readers = makeReaders({ rpc, rpc2, localTest })
  const genesis = await verifyGenesis(readers, { localTest })
  if (localTest) {
    enterLocalScope(genesis)
    if (Object.values(MAINNET_ROLES).includes(value(config, 'canaryMint'))) throw Error('Local-test canary mint must be synthetic')
  }
  const root = path.join(runsRoot, genesis.slice(0, 16), ...(stack ? [`stack-${stack.stack.id}`] : []))
  // The one-send journal lives apart from --runs so moving or cleaning run directories never drops it. Our own stack keeps
  // its own journal (and so its own table records) beside the legacy one.
  const journal = openJournal(path.join(journalRoot, genesis.slice(0, 16), ...(stack ? [`stack-${stack.stack.id}`] : [])))
  const providers = readers.map(r => r.provider)
  const chain = stack
    ? { stack: stack.stack, programs: hookPrograms(stack.profile), quoteMint: stack.stack.quoteMint, abi: { idls: stack.idls, coders: stack.coders }, elf: stack.elf,
      envelope: stackCompilerEnvelope(stack, { genesisHash: genesis, providers, local: localTest }) }
    : { ...legacyChain(), envelope: compilerEnvelope({ genesisHash: genesis, providers, local: localTest }) }
  return { config, readers, genesis, localTest, network: localTest ? 'local-test' : 'mainnet-beta', roles, ix: instructionsFor(chain.abi), ...chain,
    runsRoot, root, journal, options }
}
