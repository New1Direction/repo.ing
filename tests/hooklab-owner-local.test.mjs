// End-to-end owner driver run on a disposable native solana-test-validator (synthetic roles,
// pinned ELFs at the mainnet program IDs). Asserts the inclusive fee split from actual receipts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { main } from '../src/hooklab-owner-driver/cli.mjs'
import { ELF_DIR, VALIDATOR, syntheticRoles, writeKeyFiles, startValidator, bootstrapConfigs, localConfig, cloneBridge, cleanup, LOCAL_FEE_BPS } from './fixtures/hooklab-owner-local.mjs'

const available = existsSync(VALIDATOR) && existsSync(path.join(ELF_DIR, 'bordrless_launch.so'))
const required = process.env.HOOKLAB_OWNER_LOCAL_REQUIRED === 'true'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('owner driver runs every stage end to end on a local validator', { skip: !available && !required && 'local validator or pinned ELFs unavailable', timeout: 1800000 }, async t => {
  const root = mkdtempSync(path.join(process.env.HOOKLAB_OWNER_SCRATCH ?? tmpdir(), 'hooklab-owner-local-'))
  const roles = syntheticRoles(), keys = writeKeyFiles(path.join(root, 'keys'), roles)
  // Production bridge copy (read-only mainnet reads) enables the permissionless SOL collection route.
  const bridge = process.env.HOOKLAB_OWNER_BRIDGE_CLONE === 'false' ? null : await cloneBridge(path.join(root, 'bridge'))
  const route = bridge ? 'sol' : 'quote'
  t.diagnostic(`collect route: ${route}${bridge ? ` (bridge ELF copy sha256 ${bridge.elfSha256})` : ' (mainnet bridge copy unavailable)'}`)
  const validator = await startValidator(root, roles, { bridge })
  t.after(async () => { await validator.stop(); cleanup(root) })
  await bootstrapConfigs(validator.connection, roles, validator.genesisHash)
  const configPath = path.join(root, 'config.json')
  writeFileSync(configPath, JSON.stringify(localConfig(roles, {}, { collectRoute: route }), null, 2))
  const common = ['--local-test', '--rpc', validator.url, '--rpc2', validator.url2, '--config', configPath, '--runs', path.join(root, 'runs'), '--journal', path.join(root, 'journal')]
  const quiet = { log: () => {} }
  const planStage = async (stage, extra = []) => {
    const result = await main(['plan', stage, ...common, ...extra], quiet)
    assert.ok(result.built.review, `${stage} plan blocked: ${result.built.blocked}`)
    assert.equal(result.preview.simulation.err, null, `${stage} simulation failed: ${JSON.stringify(result.preview.simulation)}`)
    for (const file of ['plan.json', 'preview.json', 'preview.txt', 'unsigned-tx.base64']) assert.ok(existsSync(path.join(result.runDir, file)), `${stage} missing ${file}`)
    return result
  }
  const run = async (stage, signerRoles, { approve = false, extra = [] } = {}) => {
    const { built } = await planStage(stage, extra), sha = built.review.messageSha256
    const args = ['execute', stage, ...common, ...extra, '--message-sha256', sha, ...signerRoles.flatMap(r => ['--key', `${r}=${keys[r]}`]), ...(approve ? ['--approved', `${stage}:${sha}`] : [])]
    const result = await main(args, quiet)
    assert.equal(result.receipt.status, 'finalized-success', stage)
    assert.ok(result.receipt.postconditions.length > 0, `${stage} postconditions missing`)
    return { ...result, sha }
  }

  await t.test('status reads the synthetic mainnet-like starting state', async () => {
    const { text } = await main(['status', ...common], quiet)
    assert.match(text, /revision 0 gates creation=true trading=false/)
    assert.match(text, /revision 0 gates creation=false trading=true/)
  })
  await t.test('governed configuration, grant, gate finalization and funding', async () => {
    await run('launch-config', ['payer', 'admin'])
    await run('swap-config', ['payer', 'admin'])
    await run('grant', ['payer', 'admin'])
    const { built } = await planStage('gate-finalize')
    await assert.rejects(main(['execute', 'gate-finalize', ...common, '--message-sha256', built.review.messageSha256, '--key', `payer=${keys.payer}`, '--key', `upgrade=${keys.upgrade}`], quiet), /requires --approved gate-finalize:/)
    await run('gate-finalize', ['payer', 'upgrade'], { approve: true })
    await run('fund', ['payer'], { approve: true })
  })
  await t.test('canary preparation, lookup table, gated launch', async () => {
    await run('canary-prepare', ['creator', 'mint', 'selectedConfig'])
    await run('alt', ['payer']); await run('alt', ['payer'])
    const done = await main(['plan', 'alt', ...common], quiet)
    assert.match(done.built.blocked, /complete 38-address inventory/)
    await run('canary-gates-open-creation', ['payer', 'admin'], { approve: true })
    await run('canary-launch', ['creator', 'mint', 'admin'])
    await run('canary-gates-close-creation', ['payer', 'admin'])
    await run('canary-holdings', ['creator'])
  })
  const fees = []
  await t.test('atomic canary buy and sell settle platform = floor(gross/4), creator = remainder', async () => {
    for (const side of ['buy', 'sell']) {
      const result = await run(`canary-${side}`, ['creator', 'admin'], { approve: true })
      const events = result.receipt.events.filter(e => e.name === 'InclusiveCreatorFeeAccrued')
      assert.equal(events.length, 1)
      const gross = BigInt(events[0].data.gross_quote), platform = BigInt(events[0].data.platform_quote), creator = BigInt(events[0].data.creator_quote)
      assert.ok(gross > 0n)
      assert.equal(platform, gross / 4n, 'platform = floor(gross creator fee / 4)')
      assert.equal(creator, gross - platform, 'creator = remainder')
      assert.equal(events[0].data.platform_collector, roles.treasury.publicKey.toBase58())
      fees.push({ side, gross, platform, creator })
    }
    assert.equal(fees[0].gross, 1000200n * BigInt(LOCAL_FEE_BPS) / 10000n, `buy of 1,000,200 raw quote at ${LOCAL_FEE_BPS} bps`)
  })
  await t.test(`collection pays exactly the accrued creator and platform shares (${route} route)`, async () => {
    const treasury = roles.treasury.publicKey, before = await validator.connection.getBalance(treasury, 'finalized')
    const result = await run('collect', route === 'sol' ? ['creator'] : ['creator', 'admin'])
    const claimed = result.receipt.events.find(e => e.name === 'CreatorFeesClaimed'), collected = result.receipt.events.find(e => e.name === 'ProtocolFeesCollected')
    assert.equal(BigInt(claimed.data.amount), fees.reduce((n, f) => n + f.creator, 0n))
    assert.equal(BigInt(collected.data.quote_amount), fees.reduce((n, f) => n + f.platform, 0n))
    assert.equal(collected.data.collector, roles.treasury.publicKey.toBase58())
    const platformTotal = fees.reduce((n, f) => n + f.platform, 0n), after = await validator.connection.getBalance(treasury, 'finalized')
    if (route === 'sol') assert.equal(BigInt(after - before), platformTotal, 'treasury received the platform share as SOL')
  })
  await t.test('public activation opens launches and trading on both governances, then both close again', async () => {
    await run('open-launches', ['payer', 'admin'], { approve: true })
    await run('open-trading', ['payer', 'admin'], { approve: true })
    const { text } = await main(['status', ...common], quiet)
    assert.equal((text.match(/gates creation=false trading=false/g) ?? []).length, 2, text)
    await run('close-trading', ['payer', 'admin'])
    await run('close-launches', ['payer', 'admin'])
    assert.match(String((await main(['plan', 'close-trading', ...common], quiet)).built.blocked), /already closed/)
  })
  await t.test('customer-grant creates a one-launch grant, then re-enables it for exactly one more, and refuses role addresses', async () => {
    const customer = (await import('@solana/web3.js')).Keypair.generate().publicKey.toBase58()
    const first = await run('customer-grant', ['payer', 'admin'], { extra: ['--creator', customer] })
    assert.match(first.receipt.postconditions.join(' '), /one more launch allowed/)
    const second = await run('customer-grant', ['payer', 'admin'], { extra: ['--creator', customer] })
    assert.notEqual(second.sha, first.sha)
    await assert.rejects(main(['plan', 'customer-grant', ...common, '--creator', roles.creator.publicKey.toBase58()], quiet), /may not be one of the owner role addresses/)
  })
  t.diagnostic(`canary creator balance left after launch, buy, sell and collect: ${await validator.connection.getBalance(roles.creator.publicKey, 'finalized')} lamports of the funded 50000000`)
  await t.test('shared trade table: created with the 16 shared trade addresses, frozen, then complete', async () => {
    const created = await run('trade-table', ['payer'], { approve: true })
    assert.match(created.receipt.postconditions.join(' '), /holds the 16 shared trade addresses/)
    const frozen = await run('trade-table', ['payer'], { approve: true })
    assert.match(frozen.receipt.postconditions.join(' '), /frozen; data sha256 [0-9a-f]{64}/)
    const again = await main(['plan', 'trade-table', ...common], quiet)
    assert.match(String(again.built.blocked), /complete and frozen/)
  })
  await t.test('owner agent creates a per-launch table with the admin key on chain, then reclaim deactivates it', async () => {
    const { ownerTableExecutor } = await import('../src/hooklab-owner-agent-tables.mjs')
    const { launchTableInventory, verifyLaunchTable } = await import('../src/hooklab-owner-launch-tables.mjs')
    const { adminSignerFromKeypair } = await import('../src/hooklab-owner-agent.mjs')
    const { compilerEnvelope } = await import('../src/hooklab-owner-driver/artifacts.mjs')
    const { derivedAddresses, PROGRAMS: P } = await import('../src/hooklab-owner-driver/pins.mjs')
    const { Keypair, PublicKey: Key, LAMPORTS_PER_SOL } = await import('@solana/web3.js')
    const connection = validator.connection, adminAddress = roles.admin.publicKey.toBase58()
    await connection.confirmTransaction(await connection.requestAirdrop(roles.admin.publicKey, LAMPORTS_PER_SOL / 10), 'finalized')
    const envelope = compilerEnvelope({ genesisHash: validator.genesisHash, providers: ['local-a', 'local-b'], local: true })
    const config = await connection.getAccountInfo(new Key(derivedAddresses(P).launchConfig), 'finalized')
    const customer = Keypair.generate().publicKey.toBase58()
    const request = { schema: 'repoing/inclusive-max-wallet-launch-request/1', policyKind: 'max-wallet', policyVersion: 2, creator: customer, feePayer: customer,
      mint: Keypair.generate().publicKey.toBase58(), selectedConfig: Keypair.generate().publicKey.toBase58(), capBps: 500, label: 'customer', creatorFeeBps: 200, rules: 'none',
      hookFlags: 1, feeModel: 2, protocolShareBps: 2500, reviewer: adminAddress, name: 'A customer coin with a long name', symbol: 'CUSTOMER', uri: `https://repo.ing/m/${'x'.repeat(150)}`, virtualQuote: '1000000000' }
    const { inventory, inventorySha256 } = launchTableInventory(envelope, request, config.data)
    const admin = adminSignerFromKeypair(JSON.stringify([...roles.admin.secretKey]), adminAddress)
    const executor = ownerTableExecutor({ connections: [connection, connection], admin, journalDir: path.join(root, 'agent-tables'), sleep })
    const job = { preparationId: '0f3c9a52-6a43-4e0e-b8a8-2a1c1d9e7b10', launchRequestId: '5b7f4c1e-8a0f-4d55-9a49-3f7c0c2b9d11', creator: customer, mint: request.mint, inventory, inventorySha256 }
    const table = await executor.ensure(job)
    const account = await connection.getAccountInfo(new Key(table), 'finalized')
    assert.equal(verifyLaunchTable({ data: account.data, owner: account.owner.toBase58(), inventory, adminAddress }).addresses.length, inventory.length)
    assert.equal(await executor.ensure(job), table, 'a finished table is reused, never recreated')
    const reclaimed = await executor.reclaim(new Set())
    assert.match(reclaimed.join(' '), /deactivated/)
  })
  await t.test('one-send journal refuses to resend a finalized message', async () => {
    const journal = path.join(root, 'journal', validator.genesisHash.slice(0, 16), 'journal')
    const collect = readdirSync(journal).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => JSON.parse(readFileSync(path.join(journal, f), 'utf8'))).find(e => e.stage === 'collect')
    await assert.rejects(main(['execute', 'collect', ...common, '--message-sha256', collect.messageSha256, '--key', `creator=${keys.creator}`, '--key', `admin=${keys.admin}`], quiet), /already used/)
  })
  await t.test('a refreshed blockhash needs operator re-confirmation; nothing else may change', async () => {
    const { built } = await planStage('canary-gates-open-creation'), sha = built.review.messageSha256
    while (await validator.connection.getBlockHeight('finalized') <= built.review.lastValidBlockHeight) await sleep(2000)
    const args = ['execute', 'canary-gates-open-creation', ...common, '--message-sha256', sha, '--approved', `canary-gates-open-creation:${sha}`, '--key', `payer=${keys.payer}`, '--key', `admin=${keys.admin}`]
    await assert.rejects(main(args, { ...quiet, confirm: async () => false }), /not re-confirmed/)
    let confirmedSha
    const result = await main(args, { ...quiet, confirm: async fresh => { confirmedSha = fresh; return true } })
    assert.notEqual(confirmedSha, sha)
    assert.equal(result.receipt.messageSha256, confirmedSha); assert.equal(result.receipt.reviewedMessageSha256, sha)
  })
})
