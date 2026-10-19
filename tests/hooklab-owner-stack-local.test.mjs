// Our own stack's first-time setup, end to end through the real owner driver (plan, then execute) on a disposable
// solana-test-validator: the reviewed ELFs relocated to fresh program IDs (tests/fixtures/hooklab-own-stack.mjs), a
// synthetic upgrade authority, and the quote marker in genesis as hook-lab's deploy creates it. Every stage's post-state
// is verified on chain by the driver; this test also checks the end state. Synthetic keys only; never mainnet.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { main } from '../src/hooklab-owner-driver/cli.mjs'
import { STACK_IDL_FILES } from '../src/hooklab-owner-driver/artifacts.mjs'
import { parseLaunchConfigReserved, LAUNCH_CONFIG_RESERVED_AT } from '../src/hooklab-launch-config-reserved.mjs'
import { BorshCoder } from '@anchor-lang/core'
import { PublicKey } from '@solana/web3.js'
import { derivedAddresses } from '../src/hooklab-owner-driver/pins.mjs'
import { VALIDATOR, syntheticRoles, writeKeyFiles, startStackValidator, localConfig, cleanup } from './fixtures/hooklab-owner-local.mjs'
import { ownStack, OWN_STACK_SKIP } from './fixtures/hooklab-own-stack.mjs'

const available = existsSync(VALIDATOR) && !OWN_STACK_SKIP
const required = process.env.HOOKLAB_OWNER_LOCAL_REQUIRED === 'true'
const MENUS = { creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] }

test('our own stack: first-time setup through the owner driver on a local validator', { skip: !available && !required && 'local validator or reviewed ELFs unavailable', timeout: 1800000 }, async t => {
  const root = mkdtempSync(path.join(process.env.HOOKLAB_OWNER_SCRATCH ?? tmpdir(), 'hooklab-owner-stack-'))
  const roles = syntheticRoles(), keys = writeKeyFiles(path.join(root, 'keys'), roles)
  const built = ownStack({ seed: 'owner-driver', upgradeAuthority: roles.upgrade.publicKey.toBase58() }), { stack } = built
  const stackDir = path.join(root, 'stack'), idlDir = path.join(stackDir, 'idl'); mkdirSync(idlDir, { recursive: true })
  for (const [role, file] of Object.entries(STACK_IDL_FILES)) writeFileSync(path.join(idlDir, file), built.idls[role])
  writeFileSync(path.join(stackDir, 'stack.json'), JSON.stringify(stack))
  const validator = await startStackValidator(root, roles, built)
  t.after(async () => { await validator.stop(); cleanup(root) })
  const configPath = path.join(root, 'config.json'), yes = value => ({ value, approved: true })
  // No launchFeeLamports decision: launch-fee applies the owner-confirmed 0.02 SOL default.
  writeFileSync(configPath, JSON.stringify(localConfig(roles, { openCreationMenus: yes(MENUS), stackCustodyDigest: yes('5a'.repeat(32)) }), null, 2))
  const common = ['--local-test', '--rpc', validator.url, '--rpc2', validator.url2, '--config', configPath, '--runs', path.join(root, 'runs'), '--journal', path.join(root, 'journal'),
    '--stack', path.join(stackDir, 'stack.json'), '--stack-idls', idlDir]
  const quiet = { log: () => {} }
  const planStage = async (stage, extra = []) => {
    const result = await main(['plan', stage, ...common, ...extra], quiet)
    assert.ok(result.built.review, `${stage} plan blocked: ${result.built.blocked}`)
    assert.equal(result.preview.simulation.err, null, `${stage} simulation failed: ${JSON.stringify(result.preview.simulation)}`)
    return result
  }
  const run = async (stage, signerRoles, { approve = false, extra = [] } = {}) => {
    const { built: plan } = await planStage(stage, extra), sha = plan.review.messageSha256
    const result = await main(['execute', stage, ...common, ...extra, '--message-sha256', sha, ...signerRoles.flatMap(r => ['--key', `${r}=${keys[r]}`]), ...(approve ? ['--approved', `${stage}:${sha}`] : [])], quiet)
    assert.equal(result.receipt.status, 'finalized-success', stage)
    assert.ok(result.receipt.postconditions.length > 0, `${stage} postconditions missing`)
    return result
  }
  const readOnly = async stage => { const { built: result } = await main(['plan', stage, ...common], quiet); assert.equal(result.verified, true, stage); return result }
  const d = derivedAddresses(stack.programs, stack.quoteMint), launchCoder = new BorshCoder(JSON.parse(built.idls.launch))
  const launchConfig = async () => { const info = await validator.connection.getAccountInfo(new PublicKey(d.launchConfig), 'finalized'); return { bytes: info.data, config: launchCoder.accounts.decode('Config', info.data) } }

  await t.test('the deployed stack and its quote marker verify; a legacy-only stage is refused', async () => {
    const verified = await readOnly('stack-verify')
    assert.match(verified.sections[0].rows.join('\n'), new RegExp(stack.programs.gate))
    await readOnly('quote-marker')
    await assert.rejects(main(['plan', 'customer-grant', ...common, '--creator', roles.creator.publicKey.toBase58()], quiet), /legacy stack only/)
  })
  await t.test('configs and governances start as the legacy stack did on deploy day', async () => {
    await run('launch-config-init', ['payer', 'upgrade'], { approve: true })
    await run('swap-config-init', ['payer', 'upgrade'], { approve: true })
    assert.match(String((await main(['plan', 'launch-config-init', ...common], quiet)).built.blocked), /already exists/)
    await run('launch-governance-init', ['payer', 'admin'], { approve: true })
    await run('swap-governance-init', ['payer', 'admin'], { approve: true })
    await readOnly('quote-marker')
    const { config } = await launchConfig()
    assert.equal(config.quote_mint.toBase58(), stack.quoteMint); assert.equal(config.paused, true); assert.equal(config.launch_fee_lamports.toString(), '0')
  })
  await t.test('gate finalization and the approved economics, each a governed change', async () => {
    await run('gate-finalize', ['payer', 'upgrade'], { approve: true })
    await run('launch-config', ['payer', 'admin'])
    await run('swap-config', ['payer', 'admin'])
    const fee = await run('launch-fee', ['payer', 'admin'], { approve: true })
    assert.match(fee.receipt.postconditions.join(' '), /launch config matches reviewed values/)
    assert.equal((await launchConfig()).config.launch_fee_lamports.toString(), '20000000', 'the owner-confirmed 0.02 SOL creation fee')
    assert.match(String((await main(['plan', 'launch-fee', ...common], quiet)).built.blocked), /already 0\.02 SOL/)
    await run('launch-usd-bounds', ['payer', 'admin'], { approve: true })
  })
  await t.test('native launches, then open creation with the owner menus', async () => {
    await run('native-launches', ['payer', 'admin'], { approve: true, extra: ['--to', 'on'] })
    await run('open-creation', ['payer', 'admin'], { approve: true, extra: ['--to', 'on'] })
    const { bytes } = await launchConfig()
    assert.deepEqual(parseLaunchConfigReserved(bytes.subarray(LAUNCH_CONFIG_RESERVED_AT)), { native: true, open: true, ...MENUS })
    assert.match(String((await main(['plan', 'open-creation', ...common, '--to', 'on'], quiet)).built.blocked), /already ON/)
  })
  await t.test('the shared launch and trade tables: created, then frozen', async () => {
    for (const stage of ['launch-table', 'trade-table']) {
      const created = await run(stage, ['payer'], { approve: true })
      assert.match(created.receipt.postconditions.join(' '), /holds the \d+ shared/)
      const frozen = await run(stage, ['payer'], { approve: true })
      assert.match(frozen.receipt.postconditions.join(' '), /frozen; data sha256 [0-9a-f]{64}/)
      assert.match(String((await main(['plan', stage, ...common], quiet)).built.blocked), /complete and frozen/)
    }
  })
  await t.test('launches and trading open; the guardian pauses creation and only the admin reopens it', async () => {
    await run('open-launches', ['payer', 'admin'], { approve: true })
    await run('open-trading', ['payer', 'admin'], { approve: true })
    let { text } = await main(['status', ...common], quiet)
    assert.equal((text.match(/gates creation=false trading=false/g) ?? []).length, 2, text)
    const paused = await run('guardian-pause', ['payer', 'guardian'], { extra: ['--pause', 'creation'] })
    assert.match(paused.receipt.postconditions.join(' '), /creation paused/)
    ;({ text } = await main(['status', ...common], quiet))
    assert.match(text, /launch governance \w+: revision \d+ gates creation=true trading=false/)
    assert.match(String((await main(['plan', 'guardian-pause', ...common, '--pause', 'creation'], quiet)).built.blocked), /already paused/)
    await run('open-launches', ['payer', 'admin'], { approve: true })
  })
})
