import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { reservationInput, launchHookInput } from '../app/lib/hooklab-native-launch-form.mjs'
import { sameLaunchHook } from '../app/lib/hooklab-open-launch.mjs'
import { reserveNewMintSelectedHookPreparationIntent } from '../src/hooklab-new-mint-preparation.mjs'

const selectedHook = { program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', flags: 3 }
const economics = { quoteCut: { maxBuyBps: 80, maxSellBps: 40 }, authorShareBps: 1000, rules: { burnBuyBps: 20, burnSellBps: 30 } }
const intent = { name: 'Coin', symbol: 'COIN', uri: '', creatorFeeBps: 100, capBps: 0, selectedHook, ...economics }

test('form, reserve and recovery retain exact explicitly configured economics', () => {
  const reserved = reservationInput({}, intent)
  for (const key of Object.keys(economics)) assert.deepEqual(reserved[key], economics[key])
  for (const change of [{ quoteCut: undefined }, { authorShareBps: 0 }, { rules: 'none' }])
    assert.equal(sameLaunchHook(intent, { ...intent, ...change }), false)
  assert.equal(sameLaunchHook(intent, structuredClone(intent)), true)
  const defaults = { ...intent }; for (const key of Object.keys(economics)) delete defaults[key]
  const locked = reservationInput({ ...economics }, defaults)
  for (const key of Object.keys(economics)) assert.equal(locked[key], undefined, 'form cannot inject economics into locked defaults')
  assert.throws(() => launchHookInput({ capBps: 100, ...economics }), /selected hook/i)
})

test('selected preparation persists economics before consent and rejects changed intent after restart', async () => {
  const operationId = randomUUID(), rows = new Map()
  const custody = () => ({
    async reserveNewCandidate() { return structuredClone(rows.get(operationId) ?? { operationId, owner: selectedHook.program, mint: selectedHook.program, selectedConfig: selectedHook.program, stage: 'reserved', revision: '0' }) },
    async retainPreparationIntent(_token, id, { request }) {
      const row = { operationId: id, owner: selectedHook.program, mint: selectedHook.program, selectedConfig: selectedHook.program, stage: 'reserved', revision: '1', preparedRequest: request }
      rows.set(id, structuredClone(row)); return row
    },
  })
  const reserve = input => reserveNewMintSelectedHookPreparationIntent({ custody: custody(), sessionToken: 'synthetic', input: { operationId, selectedHook, label: 'COIN', creatorFeeBps: 100, ...input }, profile: { expectedSha256: 'a'.repeat(64) } })
  const first = await reserve(economics)
  for (const key of Object.keys(economics)) assert.deepEqual(first.request[key], economics[key])
  assert.equal(first.request.feeModel, 1)
  assert.deepEqual((await reserve(economics)).request, first.request)
  for (const change of [{ quoteCut: undefined }, { quoteCut: { maxBuyBps: 81, maxSellBps: 40 } }, { authorShareBps: 0 }, { rules: 'none' }])
    await assert.rejects(reserve({ ...economics, ...change }), /immutable/)
})
