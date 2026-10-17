import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CUSTOM_POLICY_PREVIEW_PIN, customPolicyPreviewSchema, previewCustomOwnerRule } from '../src/hooklab-custom-policy-preview.mjs'
import { hookExecutionContract, hookExecutionIntentSchema } from '../src/hooklab-execution-contract.mjs'
import { key } from './fixtures/hooklab-native-index.mjs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

const input = { schema: 'repoing/custom-policy-preview/1', blockedOwner: key(1), sourceOwner: key(2), destinationOwner: key(3) }

test('exact owner-rejection predicate handles source, destination and both without implying execution', () => {
  for (const [sourceOwner, destinationOwner, result] of [[key(2), key(3), 'not-rejected-by-this-rule'],
    [key(1), key(3), 'rejected-by-this-rule'], [key(2), key(1), 'rejected-by-this-rule'], [key(1), key(1), 'rejected-by-this-rule']]) {
    const out = previewCustomOwnerRule({ ...input, sourceOwner, destinationOwner })
    assert.equal(out.result, result)
    for (const key of ['onchainStateChecked', 'transactionSimulated', 'economicPostconditions', 'deploymentAdopted', 'executionEnabled']) assert.equal(out[key], false)
  }
  assert.equal(CUSTOM_POLICY_PREVIEW_PIN.program, 'BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb')
  assert.equal(CUSTOM_POLICY_PREVIEW_PIN.policy, 'immutable-canonical-single-blocked-owner')
})

test('preview refuses unknown fields, zero blocked owner, Playground, recipes and execution input', () => {
  for (const change of [{ enabled: true }, { transaction: 'bytes' }, { rpcUrl: 'https://rpc.invalid' },
    { blockedOwner: '11111111111111111111111111111111' }, { sourceOwner: '' }, { destinationOwner: ' not-a-key' },
    { schema: 'repoing-playground/1' }, { schema: 'repoing-playground-draft/1' }, { schema: 'repo-ing/hook-lab-recipe/1' }]) {
    assert.equal(customPolicyPreviewSchema.safeParse({ ...input, ...change }).success, false)
  }
  assert.equal(hookExecutionIntentSchema.safeParse(input).success, false)
})

test('review route is hidden by default and cannot be enabled by execution-like flag values', async () => {
  const { default: Page } = await appModule('app/(site)/hooks/custom/page.jsx')
  const original = process.env.HOOK_CUSTOM_POLICY_PREVIEW
  try {
    for (const value of [undefined, '', 'true', '1', 'production']) {
      if (value === undefined) delete process.env.HOOK_CUSTOM_POLICY_PREVIEW
      else process.env.HOOK_CUSTOM_POLICY_PREVIEW = value
      assert.throws(() => Page(), /NEXT_HTTP_ERROR_FALLBACK;404/)
    }
    process.env.HOOK_CUSTOM_POLICY_PREVIEW = 'local-review'
    const markup = html(h(Page))
    assert.match(markup, /Local review only/)
    assert.match(markup, /Not adopted by this app/)
    assert.match(markup, /Unverified; not queried/)
    assert.match(markup, /Creation and trading initially paused/)
    assert.match(markup, /creator grants disabled/)
    assert.match(markup, /disabled=""[^>]*>Prepare unavailable/)
    assert.match(markup, /disabled=""[^>]*>Sign and launch unavailable/)
    assert.match(markup, /No preview yet/)
    assert.doesNotMatch(markup, /<form|value="[1-9A-HJ-NP-Za-km-z]{32,44}"/)
    assert.ok(Object.values(hookExecutionContract().capabilities).every(v => v === false))
  } finally {
    if (original === undefined) delete process.env.HOOK_CUSTOM_POLICY_PREVIEW
    else process.env.HOOK_CUSTOM_POLICY_PREVIEW = original
  }
})

test('preview remains networkless and absent from public Hooks navigation', () => {
  const ui = readFileSync(new URL('../app/components/hooklab-custom-policy-preview.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(ui, /fetch\s*\(|useWallet|localStorage|sessionStorage|signTransaction|sendTransaction/)
  assert.match(ui, /setResult\(null\); setError\(''\)/)
  const nav = readFileSync(new URL('../app/components/hooks-ui.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(nav, /hooks\/custom/)
})
