import test from 'node:test'
import assert from 'node:assert/strict'
import { CLAIM_STEPS, claimStepStates, claimPageStep, builderClaimStep } from '../app/lib/claim-checklist.mjs'

test('checklist marks earlier steps done, one current, later upcoming', () => {
  assert.deepEqual(CLAIM_STEPS, ['Verify GitHub', 'Set payout wallet', 'Claim'])
  assert.deepEqual(claimStepStates(1).map(step => step.state), ['current', 'upcoming', 'upcoming'])
  assert.deepEqual(claimStepStates(2).map(step => step.state), ['done', 'current', 'upcoming'])
  assert.deepEqual(claimStepStates(3).map(step => step.state), ['done', 'done', 'current'])
  assert.equal(claimStepStates(3).filter(step => step.state === 'current').length, 1)
})

test('claim page step requires GitHub and app access before the wallet', () => {
  assert.equal(claimPageStep({ githubReady: false, appReady: true, walletMatches: true }), 1)
  assert.equal(claimPageStep({ githubReady: true, appReady: false, walletMatches: true }), 1)
  assert.equal(claimPageStep({ githubReady: true, appReady: true, walletMatches: false }), 2)
  assert.equal(claimPageStep({ githubReady: true, appReady: true, walletMatches: true }), 3)
})

test('builder step starts at GitHub when signed out or no repositories are shared', () => {
  assert.equal(builderClaimStep({ needsLogin: true, repositories: null }), 1)
  assert.equal(builderClaimStep({ needsLogin: false, repositories: [] }), 1)
  assert.equal(builderClaimStep({ needsLogin: false, repositories: null }), 2)
})

test('builder wallet step waits only on repositories with fees', () => {
  const bound = { wallet: 'W', available: '5' }
  assert.equal(builderClaimStep({ needsLogin: false, repositories: [bound, { wallet: null, available: '3' }] }), 2)
  assert.equal(builderClaimStep({ needsLogin: false, repositories: [bound, { wallet: null, available: null }] }), 2)
  assert.equal(builderClaimStep({ needsLogin: false, repositories: [bound, { wallet: null, available: '0' }] }), 3)
  assert.equal(builderClaimStep({ needsLogin: false, repositories: [bound] }), 3)
})
