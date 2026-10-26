import test from 'node:test'
import assert from 'node:assert/strict'
// Registers the JSX loader (tests/fixtures/render-jsx.mjs) before the component module loads.
import { appModule } from './fixtures/render-jsx.mjs'
const { recoveryNotice } = await appModule('app/components/root-document.jsx')

// The notice lists only what is not working yet.
test('the recovery notice names only what is not live', () => {
  assert.equal(recoveryNotice(true), 'Builder fee claims open soon. Hooks and bundles are not live yet. ' +
    'Partner fees on markets from older launch configs can still be claimed by a retired key.')
  assert.match(recoveryNotice(false), /^New launches are paused\. /)
  assert.doesNotMatch(recoveryNotice(true), /Trading is live|Charts/)
})
