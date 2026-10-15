import test from 'node:test'
import assert from 'node:assert/strict'
import { previewHookLabIntegration, integrationManifest } from '@repo-ing/hooklab-readonly'
import { defaultDirectPlan } from '../src/direct-coins.mjs'
import {
  HOOK_LAB_RECIPE_VERSION, HOOK_LAB_RECIPE_STORAGE_KEY, HOOK_LAB_RECIPE_MAX_BYTES,
  createHookLabRecipe, parseHookLabRecipe, serializeHookLabRecipe, importHookLabRecipe,
  resumeHookLabRecipe, exportHookLabRecipe, saveHookLabRecipe, loadHookLabRecipe,
  migrateDirectPlanV1ToHookLabRecipe, hookLabRecipeEnvelopeSchema, hookLabRecipeSaveSchema,
} from '../src/hook-lab-recipe.mjs'
import { recipeCases, memoryStorage } from './fixtures/hook-lab-recipes.mjs'

for (const [template, recipe] of recipeCases) test(`${template}: device, transport, export/import and resume preserve complete intent`, () => {
  const envelope = createHookLabRecipe(recipe, template)
  const storage = memoryStorage()
  assert.equal(loadHookLabRecipe(storage), null)
  saveHookLabRecipe(storage, envelope)
  saveHookLabRecipe(storage, envelope)
  const loaded = loadHookLabRecipe(storage)
  assert.deepEqual(loaded, envelope)
  assert.equal(loaded.template, template)
  const transported = importHookLabRecipe(serializeHookLabRecipe(loaded))
  assert.deepEqual(transported, envelope)
  assert.equal(exportHookLabRecipe(transported), JSON.stringify(recipe))
  assert.deepEqual(resumeHookLabRecipe(importHookLabRecipe(exportHookLabRecipe(transported))), recipe)
  assert.deepEqual(previewHookLabIntegration(resumeHookLabRecipe(transported)), previewHookLabIntegration(recipe))
  assert.deepEqual(previewHookLabIntegration(recipe).refusals, [])
  loaded.recipe.blocks.reverse()
  assert.deepEqual(loadHookLabRecipe(storage), envelope, 'resuming cannot mutate stored intent')

  // Every editable numeric field may be unfinished. Never manufacture zero.
  const unfinished = structuredClone(recipe)
  for (const block of unfinished.blocks) for (const key of Object.keys(block)) {
    if (typeof block[key] === 'number' && block.type !== 'exit_halflife') block[key] = null
  }
  assert.deepEqual(resumeHookLabRecipe(importHookLabRecipe(serializeHookLabRecipe(createHookLabRecipe(unfinished, template)))), unfinished)
})

test('absent, null and zero stay distinct; unknown blocks and all SDK block fields survive without narrowing', () => {
  const recipe = {
    format: 'hook-lab/1', coin: { name: '  Mixed Case  ', ticker: 'aBc', metadata: { text: '🪙\u0000\ud800', enabled: false } },
    blocks: [
      { type: 'creator_fee', buy_bps: 125, sell_bps: 125 },
      { type: 'burn', buy_bps: 0, sell_bps: null },
      { type: 'early_lock', window_secs: 0 },
      { type: 'sniper_fee', start_bps: 8000, secs_secs: 30 },
      { type: 'dev_vest', days_secs: 86400, buy_bps: 100 },
      { type: 'fee_split', bb_bps: 7000, h_bps: 1500 },
      { type: 'lottery', fill_bps: 200, round_secs: 3600 },
      { type: 'future_rule', opaque: [null, 0, false, { enabled: true, decimal: 0.125 }] },
      JSON.parse('{"type":"extension","__proto__":{"enabled":true},"constructor":"data"}'),
      { type: 'burn', buy_bps: 10, sell_bps: 20 }, // Duplicates belong to the SDK, too.
    ],
  }
  const envelope = createHookLabRecipe(recipe)
  const resumed = resumeHookLabRecipe(importHookLabRecipe(exportHookLabRecipe(envelope)))
  assert.deepEqual(resumed, recipe)
  assert.deepEqual(hookLabRecipeEnvelopeSchema.parse(envelope), envelope, 'schema consumers must not get a narrowed projection')
  assert.equal(Object.hasOwn(resumed.blocks[2], 'lock_secs'), false)
  assert.equal(resumed.blocks[1].sell_bps, null)
  assert.equal(resumed.blocks[1].buy_bps, 0)
  assert.deepEqual(previewHookLabIntegration(resumed), previewHookLabIntegration(recipe))
  assert.ok(previewHookLabIntegration(resumed).refusals.some(r => /Unknown block/.test(r.message)))
  const empty = { format: 'hook-lab/1', coin: { name: '', ticker: '' }, blocks: [] }
  assert.deepEqual(resumeHookLabRecipe(createHookLabRecipe(empty)), empty)
})

test('SDK alone decides fee ceilings/sums, locks, fixed curve and pool compatibility after resume', () => {
  const coin = { name: 'SDK Authority', ticker: 'SDK' }
  const invalid = [
    [{ type: 'creator_fee', fee_bps: 501 }],
    [{ type: 'creator_fee', fee_bps: 500 }, { type: 'holder_rewards', buy_bps: 500, sell_bps: 500 }, { type: 'burn', buy_bps: 500, sell_bps: 500 }],
    [{ type: 'early_lock', window_secs: 0, lock_secs: 0 }],
    [{ type: 'early_lock', window_secs: 60, lock_secs: 59 }],
    [{ type: 'max_wallet', pct_bps: 0 }],
    [{ type: 'exit_halflife', start_bps: 2001, half_secs: 21600, zero_secs: 172800 }],
    [...recipeCases[5][1].blocks, { type: 'max_wallet', pct_bps: 100 }],
  ]
  for (const blocks of invalid) {
    const raw = { format: 'hook-lab/1', coin, blocks }
    const resumed = resumeHookLabRecipe(importHookLabRecipe(serializeHookLabRecipe(createHookLabRecipe(raw))))
    assert.deepEqual(resumed, raw)
    const preview = previewHookLabIntegration(resumed)
    assert.ok(preview.refusals.length > 0, JSON.stringify(blocks))
    assert.deepEqual(preview, previewHookLabIntegration(raw))
    assert.ok(preview.steps.every(s => s.messageBase64 === null))
  }
  const raw = recipeCases[0][1]
  const inspection = { schemaVersion: 'hooklab-inspection/1', sourceCommit: integrationManifest().sourceCommit,
    limits: { maxCreatorFeeBps: 124, ruleBounds: { maxHolderFeeBps: 500, maxBurnBps: 500, maxRulesFeeBps: 1000 }, sniper: { startBps: 8000, windowSecs: 30 } },
    refusals: [{ code: 'DEPLOYMENT_MISMATCH', subject: 'test', message: 'Fixture refusal' }], warnings: [] }
  const preview = previewHookLabIntegration(resumeHookLabRecipe(createHookLabRecipe(raw)), inspection)
  assert.ok(preview.refusals.some(r => r.code === 'INVALID_RECIPE'))
  assert.ok(preview.refusals.some(r => r.code === 'DEPLOYMENT_MISMATCH'))
})

test('incompatible versions, authority injection and non-JSON values fail closed without overwriting', () => {
  const envelope = createHookLabRecipe(recipeCases[0][1])
  const storage = memoryStorage()
  saveHookLabRecipe(storage, envelope)
  const original = storage.getItem(HOOK_LAB_RECIPE_STORAGE_KEY)
  const invalid = [
    { ...envelope, schemaVersion: 'repo-ing/hook-lab-recipe/2' },
    { ...envelope, recipe: { ...envelope.recipe, format: 'hook-lab/2' } },
    { ...envelope, wallet: 'not-authority' }, { ...envelope, secretKey: 'never-store' },
    { ...envelope, inspection: { canSubmit: true } }, { ...envelope, canSign: true },
    { ...envelope, recipe: { ...envelope.recipe, readiness: true } },
    { ...envelope, recipe: { ...envelope.recipe, coin: { ...envelope.recipe.coin, metadata: { seed_phrase: 'never-transmit' } } } },
    { ...envelope, recipe: { ...envelope.recipe, blocks: [{ type: 'extension', privateKeyPkcs8: 'never-transmit' }] } },
  ]
  for (const value of [undefined, NaN, Infinity, -0, Number.MAX_SAFE_INTEGER + 1, 1n, () => {}, new Date(), new Map()]) {
    invalid.push({ ...envelope, recipe: { ...envelope.recipe, coin: { ...envelope.recipe.coin, extension: value } } })
  }
  const cycle = {}; cycle.self = cycle
  invalid.push({ ...envelope, recipe: { ...envelope.recipe, coin: { ...envelope.recipe.coin, cycle } } })
  invalid.push({ ...envelope, recipe: { ...envelope.recipe, blocks: new Array(1) } })
  for (const input of invalid) {
    assert.throws(() => saveHookLabRecipe(storage, input))
    assert.equal(storage.getItem(HOOK_LAB_RECIPE_STORAGE_KEY), original)
  }
  const duplicateVersion = original.replace('"schemaVersion":', '"schemaVersion":"future","schemaVersion":')
  const duplicateFee = original.replace('"fee_bps":125', '"fee_bps":0,"fee_\\u0062ps":125')
  for (const text of ['{', 'null', JSON.stringify({ ...envelope, schemaVersion: 'future' }), duplicateVersion, duplicateFee]) {
    assert.throws(() => importHookLabRecipe(text))
    storage.setItem(HOOK_LAB_RECIPE_STORAGE_KEY, text)
    assert.throws(() => loadHookLabRecipe(storage))
    assert.throws(() => saveHookLabRecipe(storage, envelope))
    assert.equal(storage.getItem(HOOK_LAB_RECIPE_STORAGE_KEY), text)
  }
  const request = { id: '89130bd7-12a8-46cc-b604-ecc8585939ab', revision: 0, envelope }
  for (const extra of [{ github_user_id: '1' }, { wallet: 'owner' }, { inspection: {} }, { transaction: 'bytes' }, { action: 'sign' }]) {
    assert.equal(hookLabRecipeSaveSchema.safeParse({ ...request, ...extra }).success, false)
  }
  assert.equal(hookLabRecipeSaveSchema.safeParse(request).success, true)
})

test('UTF-8 size limit is consistent for object input and imported JSON', () => {
  const envelope = createHookLabRecipe(recipeCases[0][1])
  envelope.recipe.coin.note = '🪙'.repeat(5000)
  assert.deepEqual(parseHookLabRecipe(envelope), envelope)
  envelope.recipe.coin.note = '🪙'.repeat(HOOK_LAB_RECIPE_MAX_BYTES / 4)
  assert.throws(() => serializeHookLabRecipe(envelope), /65536/)
  assert.throws(() => importHookLabRecipe(JSON.stringify(envelope)), /65536/)
})

test('legacy v1 migration is explicit, preserves unset vs zero and refuses unrepresentable plans', () => {
  const base = { ...defaultDirectPlan('programmable'), name: ' Legacy ', symbol: 'OLD' }
  for (const recipe of ['none', 'kit', 'halfLife']) {
    const plan = { ...base, recipe }
    const snapshot = structuredClone(plan)
    assert.throws(() => importHookLabRecipe(JSON.stringify(plan)))
    const migrated = migrateDirectPlanV1ToHookLabRecipe(plan)
    assert.equal(migrated.schemaVersion, HOOK_LAB_RECIPE_VERSION)
    assert.deepEqual(migrated.recipe.coin, { name: ' Legacy ', ticker: 'OLD' })
    assert.equal(migrated.recipe.blocks[0].fee_bps, null)
    if (recipe === 'kit') assert.deepEqual(migrated.recipe.blocks[1], { type: 'max_wallet', pct_bps: null })
    if (recipe === 'halfLife') assert.deepEqual(migrated.recipe.blocks[1], { type: 'exit_halflife', start_bps: 2000, half_secs: 21600, zero_secs: 172800 })
    assert.deepEqual(plan, snapshot)
  }
  const absent = { ...base }; delete absent.creatorFeeBps
  assert.deepEqual(migrateDirectPlanV1ToHookLabRecipe(absent).recipe.blocks, [])
  assert.deepEqual(migrateDirectPlanV1ToHookLabRecipe({ ...base, creatorFeeBps: 0 }).recipe.blocks, [{ type: 'creator_fee', fee_bps: 0 }])
  for (const patch of [{ version: 2 }, { adapter: 'raydium' }, { network: 'mainnet-beta' }, { quote: 'usdc' }, { lpPolicy: 'burn' },
    { recipe: 'custom' }, { recipe: 'lottery' }, { blocks: [] }, { wallet: 'owner' }, { kitMaxWalletBps: 100 }]) {
    assert.throws(() => migrateDirectPlanV1ToHookLabRecipe({ ...base, ...patch }))
  }
})
