// Protocol state through the REAL owner driver (src/hooklab-owner-driver), as the owner runs it, with disposable role
// keys in --local-test mode: the same plan -> preview -> execute -> finalized receipt -> postcondition path, each
// approval-gated stage approved by its exact message sha256. Order follows docs/HOOK_OWNER_LAUNCH_DAY.md: governed
// configs, the controlled grant, gate finalization, funding, the shared trade table, public activation, then the USD
// virtual-quote bounds and the native-launches switch on the candidate programs.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { main } from '../../../src/hooklab-owner-driver/cli.mjs'
import { bootstrapConfigs, localConfig } from '../../../tests/fixtures/hooklab-owner-local.mjs'

export function ownerDriver({ validator, root, roles, keys, log }) {
  const configPath = path.join(root, 'owner-config.json')
  writeFileSync(configPath, JSON.stringify(localConfig(roles), null, 2), { mode: 0o600 })
  const common = ['--local-test', '--rpc', validator.url, '--rpc2', validator.url2, '--config', configPath, '--runs', path.join(root, 'owner-runs'), '--journal', path.join(root, 'owner-journal')]
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
    log?.(`owner-driver ${stage}${extra.length ? ` ${extra.join(' ')}` : ''}: finalized ${result.receipt.signature ?? ''} (${((Date.now() - started) / 1000).toFixed(1)} s)`)
    return result
  }
  async function status() { return (await main(['status', ...common], quiet)).text }
  return { configPath, common, run, plan, status, validator, roles }
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
