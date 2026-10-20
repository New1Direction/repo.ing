// Synthetic compilation only: no RPC, persisted requests or custody.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { selectedLaunchFixture } from './fixtures/selected-hook-launch.mjs'
import { compileSelectedHookLaunchReview, launchPreparationRequest } from '../src/hooklab-max-wallet-launch.mjs'
import { coinMetadataUri, selectedCoinMetadataUri } from '../src/hooklab-coin-profile.mjs'

test('compact metadata fits maximum coin fields without relaxing the shared-table packet boundary', () => {
  const id='11111111-1111-4111-8111-111111111111', origin='https://localhost:22466'
  const compile = uri => {
    const { input } = selectedLaunchFixture()
    Object.assign(input.request, { name:'N'.repeat(32), symbol:'S'.repeat(10), uri })
    input.preparationEvidence.preparationIntentSha256=createHash('sha256').update(JSON.stringify(launchPreparationRequest(input.request))).digest('hex')
    const { review }=compileSelectedHookLaunchReview(input)
    return 1 + 64 * review.requiredSigners.length + Buffer.from(review.messageBase64,'base64').length
  }
  const compact=selectedCoinMetadataUri(origin,id)
  assert.ok(compile(compact)<=1232)
  assert.equal(compile(compact)-compile(''),Buffer.byteLength(compact))
  assert.throws(()=>compile(coinMetadataUri(origin,id)),/1232-byte packet limit/)
  assert.throws(()=>compile(selectedCoinMetadataUri(`https://${'a'.repeat(80)}.example`,id)),/1232-byte packet limit/)
})
