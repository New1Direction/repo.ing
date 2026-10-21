// Disposable loopback database; public quote identity only, no signers or network RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
import { selectedLaunchCollectorFixture } from './fixtures/selected-hook-launch.mjs'
import { nativeTradeResolver } from '../src/hooklab-native-trade-resolver.mjs'
import { selectedHookSettings } from '../src/hooklab-production-bootstrap.mjs'
import { createHash } from 'node:crypto'
import { selectedNativeSimulationFixture } from './fixtures/selected-native-trade.mjs'
import { nativeSigningLifecycle } from '../src/hooklab-native-signing.mjs'
import { compileNativeSwapReview } from '../src/hooklab-native-swap.mjs'
import { productionSchema, migrationSchema, MIGRATIONS } from '../scripts/hooklab-production-schema.mjs'
import { observeReleasedSelectedHookCompatibility } from '../src/hooklab-max-wallet-launch-collector.mjs'

function policyFixture() {
  const f = selectedLaunchCollectorFixture(), d = JSON.parse(f.dossierJson)
  d.schema = 'repoing/production-observation/2'
  for (const a of d.accounts.filter(a => ['launch-config', 'swap-config'].includes(a.role))) Object.assign(a, {
    binding: 'config-counters-v1', approvedDataBase64: f.accounts.get(a.address).dataBase64, idlSha256: f.p.idlSha256[a.role.split('-')[0]],
  })
  f.dossierJson = JSON.stringify(d); f.config.dossierSha256 = createHash('sha256').update(f.dossierJson).digest('hex')
  delete f.config.selectedHookPin
  f.config.selectedHookRelease = { schema: 'repoing/selected-hook-release/2', approvalReference: f.config.approvalReference,
    sourceCommit: f.p.sourceCommit, profileSha256: f.config.profileSha256, dossierSha256: f.config.dossierSha256,
    acceptanceSha256: 'a'.repeat(64), releaseVerificationSha256: 'b'.repeat(64), compatibilityPolicy: {
      schema: 'repoing/selected-hook-compatibility/2', referenceCommit: '7fde54001d7f0c88b17c87babf73fb40be07b3cb',
      abi: { family: 'bordrless-token-hook-v1', tokenFlagsMask: 255, registryVersion: 1, registryDiscriminator: '02daf6662c38c0cd', maxRegistryExtras: 32, allowExtraSigners: false },
      authority: { immutable: true, timelock: { program: 'BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ', minDelaySeconds: 259200, requireIdle: true }, trustedUpgradeAuthorities: [] },
    } }
  return f
}

test('durable quote authority survives restart but cannot change owner, configuration, intent or expiry', async () => {
  const module = await import('../src/hooklab-selected-trade-quotes.mjs').catch(() => ({}))
  assert.equal(typeof module.selectedTradeQuoteStore, 'function', 'durable quote store required')
  const url = new URL('postgres://postgres:launchtest@127.0.0.1:55432/postgres')
  const admin = new pg.Pool({ connectionString: url.href }), database = `selected_quotes_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`); url.pathname = `/${database}`
    pool = new pg.Pool({ connectionString: url.href })
    let now = 1000
    const store = module.selectedTradeQuoteStore(pool, { clock: () => now })
    assert.equal(module.readySelectedTradeQuoteStore(store), false)
    await assert.rejects(store.verifySchema())
    await pool.query(await readFile(new URL('../src/hooklab-selected-trade-quotes-schema.sql', import.meta.url), 'utf8'))
    await assert.rejects(store.verifySchema(), 'quote table alone cannot enable the complete authority integration')
    await pool.query(productionSchema().sql)
    for (const name of Object.keys(MIGRATIONS).filter(n => n !== 'selected-trade-quotes')) await pool.query(migrationSchema(name).sql)
    await store.verifySchema()
    assert.equal(module.readySelectedTradeQuoteStore(store), true)
    const f = policyFixture(), settings = { env: { HOOK_SELECTED_HOOKS_ENABLED: 'true' }, stack: f, open: true, connections: f.connections }
    assert.throws(() => selectedHookSettings(settings), /authority-evidence integration/)
    assert.throws(() => selectedHookSettings({ ...settings, tradeQuoteStore: { durable: true } }), /authority-evidence integration/)
    assert.deepEqual(selectedHookSettings({ ...settings, tradeQuoteStore: store }), { selectedHooksEnabled: true, selectedHookPin: null })
    assert.throws(() => nativeTradeResolver({ ...f, selectedNativeTradingEnabled: true }), /durable|authority/i)
    const resolver = nativeTradeResolver({ ...f, selectedNativeTradingEnabled: true, quoteStore: store, clock: () => now })
    const request = { id: randomUUID(), owner: 'public-wallet', stage: 'native-buy', configurationSha256: 'a'.repeat(64),
      intent: { policyKind: 'selected-hook', selectedHook: { program: 'public-hook' }, amountIn: '321', minAmountOut: '1' },
      selectedAuthorityEvidence: { authority: { kind: 'immutable' }, executableSha256: 'b'.repeat(64) }, expiresAtMs: 2000 }
    await store.retain(request)
    const restarted = module.selectedTradeQuoteStore(pool, { clock: () => now })
    const binding = { ...request, intent: { ...request.intent, minAmountOut: '297' } }
    assert.deepEqual(await restarted.authorityFor(binding), request.selectedAuthorityEvidence)
    for (const patch of [{ owner: 'other-wallet' }, { stage: 'native-sell' }, { configurationSha256: 'c'.repeat(64) },
      { intent: { ...binding.intent, amountIn: '322' } }, { intent: { ...binding.intent, quoteCut: 3 } }]) {
      await assert.rejects(restarted.authorityFor({ ...binding, ...patch }))
    }
    // The real resolver must consult SQL before trying any new observation. This ID has
    // a different configuration; reconstructing the resolver must not start over at initial authority.
    await assert.rejects(resolver.prepare({ owner: request.owner, stage: request.stage, custodyOperationId: request.id, intent: binding.intent }), /Selected quote/)
    await assert.rejects(store.retain({ ...request, selectedAuthorityEvidence: { authority: { kind: 'changed' } } }))
    await assert.rejects(pool.query('update hook_lab_selected_trade_quotes set expires_at_ms=3000 where quote_id=$1', [request.id]))
    const native = selectedNativeSimulationFixture(), intent = native.input.request
    const original = await observeReleasedSelectedHookCompatibility({ ...f, program: intent.selectedHook.program, stage: 'initial' })
    const retainedId = randomUUID()
    await store.retain({ id: retainedId, owner: intent.trader, stage: 'native-buy', configurationSha256: resolver.configurationSha256,
      intent, selectedAuthorityEvidence: original, expiresAtMs: 2000 })
    const changed = f.accounts.get(original.programData.address), changedBytes = Buffer.from(changed.dataBase64, 'base64')
    changedBytes[changedBytes.length - 1] ^= 1
    f.accounts.set(original.programData.address, { ...changed, dataBase64: changedBytes.toString('base64') })
    const reconstructed = nativeTradeResolver({ ...f, selectedNativeTradingEnabled: true, quoteStore: restarted, clock: () => now })
    await assert.rejects(reconstructed.prepare({ owner: intent.trader, stage: 'native-buy', intent, custodyOperationId: retainedId }), /Retained executable or authority changed/)
    f.accounts.set(original.programData.address, changed)
    now = 2000
    await assert.rejects(restarted.authorityFor(binding), /expired|unavailable/i)
    const { rows: [row] } = await pool.query('select * from hook_lab_selected_trade_quotes where quote_id=$1', [request.id])
    assert.deepEqual(Object.keys(row).sort(), ['quote_id', 'owner_wallet', 'stage', 'configuration_sha256', 'intent', 'selected_authority_evidence', 'expires_at_ms'].sort())
    assert.equal(row.intent.minAmountOut, undefined, 'the estimate does not retain an executable minimum')
    // An already-reviewed operation owns its authority after the short-lived estimate
    // expires. Refresh passes that immutable SQL context, never fresh client evidence.
    const trade = selectedNativeSimulationFixture(), time = Date.now(), token = Buffer.alloc(32, 63).toString('base64url')
    for (const o of trade.input.observations) o.observedAtMs = time
    Object.assign(trade.input.recentBlockhash, { observedAtMs: time })
    Object.assign(trade.input.limits, { nowMs: time, maxAgeMs: 60000, reviewExpiresAtMs: time + 60000 })
    const plan = compileNativeSwapReview(trade.input)
    const owner = plan.review.wallet, context = { schema: 'synthetic-public-authority-context', original: request.selectedAuthorityEvidence }
    await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,'https://repo.ing','general-launcher',$3,clock_timestamp()+interval '30 minutes')",
      [createHash('sha256').update(token).digest('hex'), owner, plan.review.genesisHash])
    let refreshing = false
    const signingSettings = { enabled: true, origin: 'https://repo.ing', stageOperations: { 'native-buy': 'native-selected-hook-buy' }, resolver: {
      async prepare(input) {
        if (refreshing) {
          assert.deepEqual(input.refreshContext, context)
          assert.equal(input.configurationSha256, request.configurationSha256)
        }
        return { status: 'operator-pins-and-state-verified', owner, stage: 'native-buy', review: plan.review,
          profileSha256: plan.review.profileSha256, messageSha256: plan.review.messageSha256, configurationSha256: request.configurationSha256,
          settlementContext: context, request: trade.input.request }
      },
    } }
    const operationId = randomUUID()
    await nativeSigningLifecycle(pool, signingSettings).createReview(token, operationId, { custodyOperationId: operationId, stage: 'native-buy', intent: trade.input.request })
    refreshing = true
    assert.equal((await nativeSigningLifecycle(pool, signingSettings).refreshReview(token, operationId)).status, 'reviewed')
  } finally {
    await pool?.end(); await dropTestDatabase(admin, database); await admin.end()
  }
})
