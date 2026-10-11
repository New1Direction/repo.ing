import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { DEFAULT_LABEL, dayOf, settingLines, usdText } from '../app/components/credit-keys-model.mjs'

// The "Your AI credits" section on /credits (app/components/credit-keys.jsx): its first render, what the browser may never do with a
// key, and where the page and the claim card point at it. tests/credits-keys.test.mjs covers the steps and the route.
const { CreditKeys } = await appModule('app/components/credit-keys.jsx')

test('the first render is the anchor for /credits#keys, asks nothing of anyone and shows no key', () => {
  const markup = html(h(CreditKeys))
  assert.match(markup, /<section class="credit-keys" id="keys" aria-labelledby="keys-heading"/)
  assert.match(markup, /<h2 id="keys-heading">Take your credits to work\.<\/h2>/)
  assert.match(markup, /Checking your AI credits/)
  assert.doesNotMatch(markup, /rik_|OPENAI_API_KEY|Make a key<\/button>/)
})

test('the lines for the coding tool, the limit field and the dates', () => {
  const lines = settingLines('https://inference.repo.ing/v1', `rik_${'ab'.repeat(32)}`)
  assert.deepEqual(lines.map(item => item.line), ['OPENAI_BASE_URL=https://inference.repo.ing/v1', `OPENAI_API_KEY=rik_${'ab'.repeat(32)}`])
  assert.deepEqual([usdText(75_000_000), usdText(10_000), usdText(20_505_000), DEFAULT_LABEL], ['75.00', '0.01', '20.50', 'coding-tool'])
  assert.deepEqual([dayOf('2026-11-06T19:00:00.000Z'), dayOf(null), dayOf('x')], ['2026-11-06', 'unknown', 'unknown'])
})

test('a key lives in component state only: no storage, no address, no logging, no cookie', () => {
  const source = readFileSync('app/components/credit-keys.jsx', 'utf8')
  for (const forbidden of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /history\./, /location\./, /console\./, /URLSearchParams/]) {
    assert.doesNotMatch(source, forbidden, String(forbidden))
  }
  // The only request the section makes is to its own route, never with the key in the address.
  assert.deepEqual([...source.matchAll(/fetch\(([^,)]+)/g)].map(match => match[1]), ["'/api/credits/keys'"])
})

test('the credits page shows the section only to a signed-in visitor while the packs are on; the claim card points at it', () => {
  const page = readFileSync('app/(site)/credits/page.jsx', 'utf8')
  assert.match(page, /\{session && creditsKeysSettings\(\) && <CreditKeys\/>\}/)
  assert.match(page, /if \(!creditPacksAvailable\(\)\) notFound\(\)/, 'the page itself is dark with the packs')
  const convert = readFileSync('app/components/credits-convert.jsx', 'utf8')
  assert.match(convert, /<a href="\/credits#keys">make a key on the credits page<\/a>/)
  assert.match(convert, /npx @repoing\/cli credits key/, 'the CLI stays as a second way')
})
