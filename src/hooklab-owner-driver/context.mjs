// Run context: config, two verified readers, role map, compiler envelope and journal.
import path from 'node:path'
import { loadConfig, roleAddresses, value } from './config.mjs'
import { makeReaders, verifyGenesis } from './rpc.mjs'
import { compilerEnvelope } from './artifacts.mjs'
import { openJournal } from './journal.mjs'
import { PROGRAMS, QUOTE_MINT, MAINNET_ROLES } from './pins.mjs'
import { adminStages } from './stages/admin.mjs'
import { canaryStages } from './stages/canary.mjs'
import { status } from './stages/status.mjs'
import { tradeTable } from './stages/trade-table.mjs'
import { launchUsdBounds } from './stages/launch-bounds.mjs'

export const STAGES = Object.freeze({ ...adminStages, ...canaryStages, 'trade-table': tradeTable, 'launch-usd-bounds': launchUsdBounds, status })
export const STAGE_ORDER = Object.freeze(['status', 'launch-config', 'swap-config', 'grant', 'gate-finalize', 'fund', 'canary-prepare', 'alt',
  'canary-gates-open-creation', 'canary-launch', 'canary-gates-close-creation', 'canary-holdings', 'canary-buy', 'canary-sell', 'collect', 'trade-table', 'customer-grant',
  'open-launches', 'open-trading', 'close-trading', 'close-launches', 'launch-usd-bounds'])

// Only after a verified non-mainnet genesis on two loopback RPCs: the repo compilers accept a
// local profile solely through this explicit acceptance scope (format-checked, never connected).
function enterLocalScope(genesis) {
  Object.assign(process.env, { NODE_ENV: 'development', HOOK_LOCAL_ACCEPTANCE: 'true', HOOK_LOCAL_ACCEPTANCE_GENESIS: genesis,
    HOOK_WALLET_IDENTITY_ORIGIN: 'https://127.0.0.1:19443', HOOK_WALLET_IDENTITY_DATABASE_URL: 'postgresql://127.0.0.1/hooks_local_owner_driver',
    HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY: 'https://127.0.0.1:19444', HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY: 'https://127.0.0.1:19445' })
}
export async function createContext({ configPath, rpc, rpc2, localTest = false, runsRoot, journalRoot, options = {} }) {
  const config = loadConfig(configPath)
  if (localTest !== (config.network === 'local-test')) throw Error(localTest ? '--local-test requires a config with network "local-test"' : 'A local-test config can only be used with --local-test')
  const readers = makeReaders({ rpc, rpc2, localTest })
  const genesis = await verifyGenesis(readers, { localTest })
  if (localTest) {
    enterLocalScope(genesis)
    if (Object.values(MAINNET_ROLES).includes(value(config, 'canaryMint'))) throw Error('Local-test canary mint must be synthetic')
  }
  const roles = roleAddresses(config), root = path.join(runsRoot, genesis.slice(0, 16))
  // The one-send journal lives apart from --runs so moving or cleaning run directories never drops it.
  const journal = openJournal(path.join(journalRoot, genesis.slice(0, 16)))
  return { config, readers, genesis, localTest, network: localTest ? 'local-test' : 'mainnet-beta', roles, programs: PROGRAMS, quoteMint: QUOTE_MINT,
    envelope: compilerEnvelope({ genesisHash: genesis, providers: readers.map(r => r.provider), local: localTest }), runsRoot, root, journal, options }
}
