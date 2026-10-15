import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection } from '@solana/web3.js'
import { GET, POST } from '../app/api/hook-lab/route.js'
import { createHookLabRecipe, serializeHookLabRecipe } from '../src/hook-lab-recipe.mjs'
import { hookLabRecipeRefusals } from '../src/hook-lab-preflight.mjs'
import { recipeCases } from './fixtures/hook-lab-recipes.mjs'

test('whole recipes reach the pinned parser; ignored extensions persist but never approve narrowed intent', async t => {
  const prior = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = 'https://repo.ing'
  t.after(() => { if (prior === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = prior })
  t.mock.method(Connection.prototype, 'getGenesisHash', async () => 'wrong-genesis')
  const request = (body, origin = 'https://repo.ing') => {
    const r = new Request('https://repo.ing/api/hook-lab', { method: body ? 'POST' : 'GET', headers: { origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    r.cookies = { get: () => undefined }; return r
  }
  assert.deepEqual(await (await GET(request())).json(), { signedIn: false, drafts: [], events: [] })
  for (const [template, raw] of recipeCases) {
    const envelope = createHookLabRecipe(raw, template)
    assert.deepEqual(hookLabRecipeRefusals(envelope), [])
    const body = { action: 'inspect', confirmedNetwork: 'devnet', envelopeText: serializeHookLabRecipe(envelope) }
    const response = await POST(request(body)), { observation } = await response.json()
    assert.equal(response.status, 200)
    assert.equal(observation.canBuild, false); assert.equal(observation.canSimulate, false)
    assert.equal(observation.canSign, false); assert.equal(observation.canSubmit, false)
    assert.equal(observation.bindingContext, null)
    assert.ok(observation.intent.refusals.some(r => r.code === 'WRONG_GENESIS'))
    assert.equal(observation.intent.rules.burnBuyBps, raw.blocks.find(b => b.type === 'burn')?.buy_bps ?? 0)
    assert.equal(observation.intent.rules.burnSellBps, raw.blocks.find(b => b.type === 'burn')?.sell_bps ?? 0)
    assert.ok(observation.intent.steps.every(s => s.messageBase64 === null))
    assert.equal((await POST(request({ ...body, confirmedNetwork: 'mainnet-beta' }))).status, 400)
  }
  const extension = createHookLabRecipe({ ...recipeCases[0][1], coin: { ...recipeCases[0][1].coin, unsupportedAuthority: 'preserve' },
    blocks: [{ type: 'burn', buy_bps: 35, sell_bps: 80, futureRule: { fee: 700 } }] })
  const body = { action: 'inspect', confirmedNetwork: 'devnet', envelopeText: serializeHookLabRecipe(extension) }
  const { observation } = await (await POST(request(body))).json()
  assert.equal(observation.intent.refusals.filter(r => r.code === 'UNSUPPORTED_RECIPE_FIELD').length, 2)
  assert.deepEqual(observation.intent.steps, [])
  assert.equal(extension.recipe.blocks[0].futureRule.fee, 700)
  assert.equal((await POST(request(body, 'https://evil.invalid'))).status, 403)
  for (const action of ['build', 'simulate', 'sign', 'send']) assert.equal((await POST(request({ ...body, action }))).status, 400)
  const quote = await POST(request({ ...body, action: 'quote' }))
  assert.equal(quote.status, 422)
  assert.deepEqual((await quote.json()).quote.exactWalletDebitLamports, null)
  assert.equal((await POST(request({ ...body, transaction: 'not-accepted' }))).status, 400)
  assert.equal((await POST(request({ ...body, envelopeText: body.envelopeText.replace('"buy_bps":35', '"buy_bps":0,"buy_bps":35') }))).status, 400)
  assert.equal((await POST(request({ action: 'save', id: 'fd54a54b-a976-4de4-9a49-f28a059f3a27', revision: 0, envelopeText: body.envelopeText }))).status, 401)
})
