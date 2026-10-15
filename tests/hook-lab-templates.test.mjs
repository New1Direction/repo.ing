import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { previewHookLabIntegration } from '@repo-ing/hooklab-readonly'
import {
  HOOK_LAB_BLOCKS, HOOK_LAB_TEMPLATES, HOOK_LAB_TEMPLATE_PIN,
  createHookLabTemplateDraft, exportHookLabTemplate, hookLabTemplateDraftSchema,
} from '../src/hook-lab-templates.mjs'

const coin = { name: 'Example', ticker: 'EX' }
const halfLife = { type: 'exit_halflife', start_bps: 2000, half_secs: 21600, zero_secs: 172800 }
const cases = [
  ['plain', [], 'plain', {}],
  ['creator-rewards', [{ type: 'creator_fee', fee_bps: 125 }], 'plain', {}],
  ['burns', [{ type: 'burn', buy_bps: 35, sell_bps: 80 }], 'plain', { burnBuyBps: 35, burnSellBps: 80 }],
  ['locks', [{ type: 'creator_lock', days_secs: 86400 }, { type: 'early_lock', window_secs: 45, lock_secs: 7200 }], 'kit',
    { creatorLockSecs: 86400, earlyWindowSecs: 45, earlyLockSecs: 7200 }],
  ['max-wallet', [{ type: 'max_wallet', pct_bps: 175 }], 'kit', { maxWalletBps: 175 }],
  ['half-life', [halfLife], 'halfLife', {}],
  ['creator-rewards', [{ type: 'creator_fee', fee_bps: 125 }, { type: 'holder_rewards', buy_bps: 25, sell_bps: 75 },
    { type: 'burn', buy_bps: 0, sell_bps: 30 }, { type: 'max_wallet', pct_bps: 150 },
    { type: 'creator_lock', days_secs: 172800 }, { type: 'early_lock', window_secs: 60, lock_secs: 3600 }], 'kit',
  { holderFeeBuyBps: 25, holderFeeSellBps: 75, burnBuyBps: 0, burnSellBps: 30, maxWalletBps: 150,
    creatorLockSecs: 172800, earlyWindowSecs: 60, earlyLockSecs: 3600 }],
  ['half-life', [halfLife, { type: 'creator_fee', fee_bps: 50 }, { type: 'burn', buy_bps: 10, sell_bps: 20 }], 'halfLife',
    { burnBuyBps: 10, burnSellBps: 20 }],
]
const draft = (templateId, blocks) => ({ templateId, coin, blocks })

test('six templates export only exact raw recipe fields, preserving asymmetric rates and seconds', () => {
  assert.deepEqual(HOOK_LAB_TEMPLATES.map(template => template.id), ['plain', 'creator-rewards', 'burns', 'locks', 'max-wallet', 'half-life'])
  for (const [id, blocks] of cases) {
    const input = draft(id, blocks)
    const output = exportHookLabTemplate(input)
    assert.deepEqual(output, { format: 'hook-lab/1', coin, blocks })
    assert.deepEqual(JSON.parse(JSON.stringify(output)), output)
    output.coin.name = 'Changed'
    if (output.blocks.length) output.blocks[0].type = 'Changed'
    assert.equal(input.coin.name, 'Example')
    assert.notEqual(input.blocks[0]?.type, 'Changed')
  }
})

test('editable parameters stay blank until explicitly chosen; zero is never inferred', () => {
  for (const id of ['creator-rewards', 'burns', 'locks', 'max-wallet']) {
    const input = createHookLabTemplateDraft(id, coin)
    assert.equal(hookLabTemplateDraftSchema.safeParse(input).success, true)
    for (const [key, value] of Object.entries(input.blocks[0])) if (key !== 'type') assert.equal(value, null)
    assert.throws(() => exportHookLabTemplate(input), error => error.issues.some(issue => issue.path[0] === 'blocks'))
  }
  assert.throws(() => exportHookLabTemplate(createHookLabTemplateDraft('plain')))
  assert.deepEqual(exportHookLabTemplate(createHookLabTemplateDraft('plain', coin)).blocks, [])
  assert.deepEqual(exportHookLabTemplate(draft('creator-rewards', [{ type: 'creator_fee', fee_bps: 0 }])).blocks,
    [{ type: 'creator_fee', fee_bps: 0 }])
  for (const value of [undefined, null, '', '100', NaN, Infinity, -1, 0.5, 10001]) {
    assert.throws(() => exportHookLabTemplate(draft('creator-rewards', [{ type: 'creator_fee', fee_bps: value }])))
  }
  assert.throws(() => exportHookLabTemplate(draft('burns', [{ type: 'burn', buy_bps: 50 }])))
})

test('only wire bounds are local; SDK owns live ceilings, aggregate fees and lock relationships', () => {
  assert.equal(exportHookLabTemplate(draft('creator-rewards', [{ type: 'creator_fee', fee_bps: 10000 }])).blocks[0].fee_bps, 10000)
  assert.equal(exportHookLabTemplate(draft('locks', [{ type: 'creator_lock', days_secs: 0xffffffff }])).blocks[0].days_secs, 0xffffffff)
  assert.throws(() => exportHookLabTemplate(draft('locks', [{ type: 'creator_lock', days_secs: 0x100000000 }])))
  // Complete JSON does not mean the SDK will accept its economics or timing.
  const blocks = [{ type: 'creator_lock', days_secs: 0 }, { type: 'early_lock', window_secs: 60, lock_secs: 60 }]
  assert.deepEqual(exportHookLabTemplate(draft('locks', blocks)).blocks, blocks)
})

test('fixed Half-Life cannot be edited or combined with Kit, even with zero-valued Kit fields', () => {
  assert.deepEqual(exportHookLabTemplate(createHookLabTemplateDraft('half-life', coin)).blocks, [halfLife])
  for (const field of ['start_bps', 'half_secs', 'zero_secs']) {
    assert.throws(() => exportHookLabTemplate(draft('half-life', [{ ...halfLife, [field]: halfLife[field] + 1 }])))
    assert.throws(() => exportHookLabTemplate(draft('half-life', [{ ...halfLife, [field]: null }])))
  }
  for (const block of [{ type: 'holder_rewards', buy_bps: 0, sell_bps: 0 }, { type: 'max_wallet', pct_bps: 0 },
    { type: 'creator_lock', days_secs: 0 }, { type: 'early_lock', window_secs: 0, lock_secs: 0 }]) {
    assert.throws(() => exportHookLabTemplate(draft('half-life', [halfLife, block])))
  }
  assert.throws(() => exportHookLabTemplate(draft('max-wallet', [{ type: 'max_wallet', pct_bps: 200 }, halfLife])))
})

test('template boundaries reject dropped, duplicate, unknown, deferred and execution-related input', () => {
  for (const id of ['constructor', 'lottery', 'custom', 'companion']) assert.throws(() => createHookLabTemplateDraft(id, coin))
  for (const input of [
    draft('max-wallet', []),
    draft('plain', [{ type: 'creator_fee', fee_bps: 50 }, { type: 'creator_fee', fee_bps: 100 }]),
    ...['custom_hook', 'lottery', 'fee_split', 'dev_vest', 'sniper_fee', 'burn_other', 'snowball', 'lossback'].map(type => draft('plain', [{ type }])),
    { ...draft('plain', []), transaction: 'bytes' },
    { ...draft('plain', []), rpcUrl: 'https://example.invalid' },
    { ...draft('plain', []), checks: { ready: true } },
    { ...draft('plain', []), coin: { ...coin, secretKey: 'not accepted' } },
    draft('plain', [{ type: 'creator_fee', fee_bps: 50, recipient: 'not supported' }]),
    draft('plain', [{ type: 'creator_fee', buy_bps: 50, sell_bps: 50 }]),
  ]) assert.throws(() => exportHookLabTemplate(input))
})

test('coin metadata uses UTF-8 bytes and ASCII tickers without truncation or sanitizing invalid input', () => {
  const input = createHookLabTemplateDraft('plain', { name: `  ${'é'.repeat(16)}  `, ticker: 'rEpO9' })
  assert.deepEqual(exportHookLabTemplate(input).coin, { name: 'é'.repeat(16), ticker: 'REPO9' })
  for (const name of [' ', 'é'.repeat(17)]) assert.throws(() => exportHookLabTemplate({ ...input, coin: { ...coin, name } }))
  for (const ticker of ['', 'A'.repeat(11), 'répo', ' REPO', '$REPO']) assert.throws(() => exportHookLabTemplate({ ...input, coin: { ...coin, ticker } }))
})

// Validate the actual installed consumer; no private upstream checkout is needed in CI.
test('pinned upstream accepts all template mappings and remains the authority for recipe refusals', () => {
  const upstream = 'vendor/hooklab-readonly'
  const pin = HOOK_LAB_TEMPLATE_PIN
  assert.equal(JSON.parse(readFileSync(join(upstream, 'provenance.json'))).revision, pin.deliveryCommit)
  const bytes = readFileSync(join(upstream, 'integration/devnet.json'))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.manifestSha256)
  const manifest = JSON.parse(bytes)
  assert.equal(manifest.sourceCommit, pin.sourceCommit)
  const programs = manifest.programs.filter(program => program.idlPath)
  assert.equal(programs.length, 11)
  for (const program of programs) {
    const idlBytes = readFileSync(join(upstream, 'idl', `${program.role}.json`))
    assert.equal(createHash('sha256').update(idlBytes).digest('hex'), program.idlSha256)
    assert.equal(JSON.parse(idlBytes).address, program.programId)
  }
  for (const block of Object.values(HOOK_LAB_BLOCKS)) for (const field of Object.values(block.fields)) {
    if (field.fixed !== undefined) continue
    const [program, type, name] = field.source.split('.')
    const idl = JSON.parse(readFileSync(join(upstream, 'idl', `${program}.json`)))
    assert.ok(idl.types.find(entry => entry.name === type)?.type.fields.some(entry => entry.name === name), field.source)
  }
  for (const [id, blocks, recipe, rules] of cases) {
    const result = previewHookLabIntegration(exportHookLabTemplate(draft(id, blocks)))
    assert.deepEqual(result.refusals, [])
    assert.equal(result.recipe, recipe)
    assert.equal(result.creatorFeeBps, blocks.find(block => block.type === 'creator_fee')?.fee_bps ?? 0)
    for (const [key, value] of Object.entries(rules)) assert.equal(result.rules[key], value, key)
    assert.equal(result.kind, 'intent-only')
    assert.equal(result.exactWalletDebitLamports, null)
    assert.ok(result.steps.every(step => step.messageBase64 === null))
  }
  const raw = exportHookLabTemplate(draft('creator-rewards', [{ type: 'creator_fee', fee_bps: 125 }]))
  const inspection = { schemaVersion: 'hooklab-inspection/1', sourceCommit: pin.sourceCommit, cluster: 'devnet', observedSlot: 123,
    limits: { maxCreatorFeeBps: 124, ruleBounds: { maxHolderFeeBps: 500, maxBurnBps: 500, maxRulesFeeBps: 1000 }, sniper: { startBps: 8000, windowSecs: 30 } }, accounts: {}, refusals: [], warnings: [] }
  assert.ok(previewHookLabIntegration(raw, inspection).refusals.some(refusal => refusal.code === 'INVALID_RECIPE'))
  inspection.limits.maxCreatorFeeBps = 125
  assert.deepEqual(previewHookLabIntegration(raw, inspection).refusals, [])
  inspection.refusals = [{ code: 'ACCOUNT_MISMATCH', subject: 'launch', message: 'Fixture refusal' }]
  assert.deepEqual(previewHookLabIntegration(raw, inspection).refusals, inspection.refusals)
  for (const input of [
    draft('max-wallet', [{ type: 'max_wallet', pct_bps: 0 }]),
    draft('locks', [{ type: 'creator_lock', days_secs: 0 }, { type: 'early_lock', window_secs: 60, lock_secs: 60 }]),
    draft('locks', [{ type: 'creator_lock', days_secs: 0 }, { type: 'early_lock', window_secs: 0, lock_secs: 0 }]),
    draft('creator-rewards', [{ type: 'creator_fee', fee_bps: 400 }, { type: 'holder_rewards', buy_bps: 400, sell_bps: 0 },
      { type: 'burn', buy_bps: 300, sell_bps: 0 }]),
  ]) assert.ok(previewHookLabIntegration(exportHookLabTemplate(input)).refusals.some(refusal => refusal.code === 'INVALID_RECIPE'))
})
