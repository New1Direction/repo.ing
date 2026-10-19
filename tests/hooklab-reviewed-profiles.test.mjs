// The reconcile allowlist of reviewed operator profiles: production bundle 2 is in it, and an envelope or funding
// profile is accepted only with its own hash, on today's chain, programs and providers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { REVIEWED_PROFILE_SHA256, reviewedEnvelope, reviewedFundingProfile } from '../src/hooklab-reviewed-profiles.mjs'

const bundle = JSON.parse(readFileSync(new URL('../config/hooklab-production-bundle-2.json', import.meta.url), 'utf8'))
const sha = text => createHash('sha256').update(text).digest('hex')

test('production bundle 2’s profile is a reviewed profile', () => {
  assert.equal(sha(bundle.profile.json), bundle.profile.expectedSha256)
  assert.ok(REVIEWED_PROFILE_SHA256.includes(bundle.profile.expectedSha256)); assert.ok(Object.isFrozen(REVIEWED_PROFILE_SHA256))
})

test('a stored envelope is accepted only with its own hash, an allowed hash, today’s providers and today’s chain', () => {
  const json = JSON.stringify({ ...JSON.parse(bundle.profile.json), profileId: 'next' }), today = { ...bundle.profile, json, expectedSha256: sha(json) }
  assert.equal(reviewedEnvelope(bundle.profile, today), true)
  assert.equal(reviewedEnvelope(bundle.profile, today, []), false, 'not in the list')
  assert.equal(reviewedEnvelope({ ...bundle.profile, expectedSha256: '0'.repeat(64) }, today, ['0'.repeat(64)]), false, 'a hash that is not its JSON’s')
  assert.equal(reviewedEnvelope({ ...bundle.profile, providers: [...bundle.profile.providers].reverse() }, today), false, 'other providers')
  const otherChain = JSON.stringify({ ...JSON.parse(json), genesisHash: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY' })
  assert.equal(reviewedEnvelope(bundle.profile, { ...today, json: otherChain }), false, 'another chain')
  assert.equal(reviewedEnvelope(null, today), false)
})

test('a stored funding profile is accepted only with an allowed hash on today’s chain, programs, mint and providers', () => {
  const p = JSON.parse(bundle.profile.json), stored = { genesisHash: p.genesisHash, programs: p.programs, quoteMint: p.quoteMint, profileSha256: bundle.profile.expectedSha256, providers: bundle.profile.providers }
  const today = { ...stored, profileSha256: 'f'.repeat(64) }
  assert.equal(reviewedFundingProfile(stored, today), true)
  assert.equal(reviewedFundingProfile(stored, today, []), false)
  for (const change of [{ quoteMint: p.programs.token }, { providers: [...stored.providers].reverse() }, { programs: { ...p.programs, swap: p.programs.launch } }])
    assert.equal(reviewedFundingProfile({ ...stored, ...change }, today), false, JSON.stringify(Object.keys(change)))
})
