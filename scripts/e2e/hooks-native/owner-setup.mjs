// Protocol state through the REAL owner driver (src/hooklab-owner-driver), as the owner runs it, with disposable role
// keys in --local-test mode: the same plan -> preview -> execute -> finalized receipt -> postcondition path, each
// approval-gated stage approved by its exact message sha256. Order follows docs/HOOK_OWNER_LAUNCH_DAY.md: governed
// configs, the controlled grant, gate finalization, funding, the shared trade table, public activation, then the USD
// virtual-quote bounds and the native-launches switch on the candidate programs.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { main } from '../../../src/hooklab-owner-driver/cli.mjs'
import { STACK_IDL_FILES } from '../../../src/hooklab-owner-driver/artifacts.mjs'
import { bootstrapConfigs, localConfig } from '../../../tests/fixtures/hooklab-owner-local.mjs'

// decisions: extra owner decisions for the mode (each approved), e.g. self-serve's menus and creation fee.
// own: our own stack (program-sets.mjs ownStackSet): the driver then runs it (--stack/--stack-idls: its descriptor and
// its build's IDLs, written as the owner's scripts/hooklab-stack-descriptor.mjs writes them), with its own runs and journal.
export function ownerDriver({ validator, root, roles, keys, log, decisions = {}, own = null }) {
  const name = own ? 'owner-own' : 'owner'
  const configPath = path.join(root, `${name}-config.json`)
  const approved = Object.fromEntries(Object.entries(decisions).map(([key, value]) => [key, { value, approved: true }]))
  writeFileSync(configPath, JSON.stringify(localConfig(roles, approved), null, 2), { mode: 0o600 })
  const stackArgs = []
  if (own) {
    const dir = path.join(root, 'own-stack'), idlDir = path.join(dir, 'idl'); mkdirSync(idlDir, { recursive: true, mode: 0o700 })
    for (const [role, file] of Object.entries(STACK_IDL_FILES)) writeFileSync(path.join(idlDir, file), own.idls[role])
    writeFileSync(path.join(dir, 'stack.json'), JSON.stringify(own.stack, null, 2))
    stackArgs.push('--stack', path.join(dir, 'stack.json'), '--stack-idls', idlDir)
  }
  const journalRoot = path.join(root, `${name}-journal`)
  const common = ['--local-test', '--rpc', validator.url, '--rpc2', validator.url2, '--config', configPath, '--runs', path.join(root, `${name}-runs`), '--journal', journalRoot, ...stackArgs]
  const quiet = { log: () => {}, confirm: async () => true }
  async function plan(stage, extra = []) {
    const result = await main(['plan', stage, ...common, ...extra], quiet)
    if (!result.built.review) throw Error(`${stage} plan blocked: ${result.built.blocked}`)
    if (result.preview.simulation.err !== null) throw Error(`${stage} simulation failed: ${JSON.stringify(result.preview.simulation)}`)
    return result
  }
  /** plan then execute one stage; approval-gated stages are approved for exactly the planned message. */
  async function run(stage, signerRoles, { approve = false, extra = [] } = {}) {
    const started = Date.now(), { built } = await plan(stage, extra), sha = built.review.messageSha256
    const args = ['execute', stage, ...common, ...extra, '--message-sha256', sha, ...signerRoles.flatMap(role => ['--key', `${role}=${keys[role]}`]), ...(approve ? ['--approved', `${stage}:${sha}`] : [])]
    const result = await main(args, quiet)
    if (result.receipt.status !== 'finalized-success') throw Error(`${stage}: ${result.receipt.status}`)
    log?.(`${own ? 'owner-driver (own stack)' : 'owner-driver'} ${stage}${extra.length ? ` ${extra.join(' ')}` : ''}: finalized ${result.receipt.signature ?? ''} (${((Date.now() - started) / 1000).toFixed(1)} s)`)
    return result
  }
  async function status() { return (await main(['status', ...common], quiet)).text }
  // A public record the driver keeps (e.g. trade-table, launch-table-<stack id>), wherever under its journal root it lives.
  const journal = record => {
    const find = dir => { for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const at = path.join(dir, entry.name)
      if (entry.isDirectory()) { const found = find(at); if (found) return found } else if (entry.name === `${record}.public.json`) return at
    } return null }
    const file = find(journalRoot); return file ? JSON.parse(readFileSync(file, 'utf8')) : null
  }
  return { configPath, common, run, plan, status, validator, roles, journal, own }
}

/** Mainnet-like protocol state with every switch the native release needs. The configs start as mainnet's did (both
 * paused, governance revision 0, bound to this validator's genesis) via the integration test's init_config/init_governance. */
export async function setupProtocol(driver) {
  await bootstrapConfigs(driver.validator.connection, driver.roles, driver.validator.genesisHash)
  await driver.run('launch-config', ['payer', 'admin'])
  await driver.run('swap-config', ['payer', 'admin'])
  await driver.run('grant', ['payer', 'admin'])
  await driver.run('gate-finalize', ['payer', 'upgrade'], { approve: true })
  await driver.run('fund', ['payer'], { approve: true })
  await driver.run('trade-table', ['payer'], { approve: true })
  await driver.run('trade-table', ['payer'], { approve: true })
  await driver.run('open-launches', ['payer', 'admin'], { approve: true })
  await driver.run('open-trading', ['payer', 'admin'], { approve: true })
}

/** The release's two governed switches, in the owner's order: USD virtual-quote bounds, then native launches on. */
export async function switchNativeOn(driver) {
  await driver.run('launch-usd-bounds', ['payer', 'admin'], { approve: true })
  await driver.run('native-launches', ['payer', 'admin'], { approve: true, extra: ['--to', 'on'] })
}

/** The protocol state each stack mode needs. Returns the shared tables the bundle pins. */
export async function setupForMode(driver, mode, { preflight, log }) {
  await setupProtocol(driver)
  if (mode === 'native') {
    log?.(`native preflight before the switch: ok=${preflight()}`)
    await switchNativeOn(driver)
  }
  const tradeTable = driver.journal('trade-table')?.address
  if (!tradeTable) throw Error('the owner driver did not record the shared trade table')
  return { tradeTable, launchTable: null }
}

/** Our own stack's first-time setup, in the owner runbook's order (docs/HOOK_OWNER_LAUNCH_DAY.md; the driver's
 * STACK_STAGE_ORDER): verify the deployed stack and quote marker, initialise configs and governances, finalize the gate,
 * the approved economics, the 0.02 SOL creation fee, the USD bounds, native launches, open creation with the owner's
 * menus, the shared launch and trade tables (created, then frozen), then launches and trading open. */
export async function setupOwnStack(driver) {
  for (const stage of ['stack-verify', 'quote-marker']) {
    const { built } = await main(['plan', stage, ...driver.common], { log: () => {} })
    if (built.verified !== true) throw Error(`${stage} did not verify: ${built.blocked ?? JSON.stringify(built.sections ?? [])}`)
  }
  await driver.run('launch-config-init', ['payer', 'upgrade'], { approve: true })
  await driver.run('swap-config-init', ['payer', 'upgrade'], { approve: true })
  await driver.run('launch-governance-init', ['payer', 'admin'], { approve: true })
  await driver.run('swap-governance-init', ['payer', 'admin'], { approve: true })
  await driver.run('gate-finalize', ['payer', 'upgrade'], { approve: true })
  await driver.run('launch-config', ['payer', 'admin'])
  await driver.run('swap-config', ['payer', 'admin'])
  await driver.run('launch-fee', ['payer', 'admin'], { approve: true })
  await driver.run('launch-usd-bounds', ['payer', 'admin'], { approve: true })
  await driver.run('native-launches', ['payer', 'admin'], { approve: true, extra: ['--to', 'on'] })
  await driver.run('open-creation', ['payer', 'admin'], { approve: true, extra: ['--to', 'on'] })
  for (const stage of ['launch-table', 'trade-table']) { await driver.run(stage, ['payer'], { approve: true }); await driver.run(stage, ['payer'], { approve: true }) }
  await driver.run('open-launches', ['payer', 'admin'], { approve: true })
  await driver.run('open-trading', ['payer', 'admin'], { approve: true })
  const tradeTable = driver.journal('trade-table')?.address, launchTable = driver.journal(`launch-table-${driver.own.stack.id}`)?.address
  if (!tradeTable || !launchTable) throw Error('the owner driver did not record our stack\'s shared tables')
  return { tradeTable, launchTable }
}
