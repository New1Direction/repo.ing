import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { DEFAULT_LABEL, dayOf, settingLines, usdText } from '../app/components/credit-keys-model.mjs'

// The "Your AI credits" section on /credits (app/components/credit-keys.jsx): its first render, what the browser may never do with a
// key, and where the page and the claim card point at it. tests/credits-keys.test.mjs covers the steps and the route.
const { CreditKeys } = await appModule('app/components/credit-keys.jsx')
const { creditKeysAvailable } = await import('../app/lib/credit-packs.mjs')
const ON = { REPO_INFERENCE_HANDOFF_ENABLED: 'true', REPO_INFERENCE_HANDOFF_SECRET: 'c'.repeat(40), HANDOFF_ASSERTION_SECRET: 'a'.repeat(40),
  CREDITS_WEB_PACKS_ENABLED: 'true', REPO_INFERENCE_CREDITS_ORIGIN: 'https://credits.repo.ing', CREDITS_TREASURY_ADDRESS: '11111111111111111111111111111111',
  DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', GITHUB_APP_CLIENT_SECRET: 'secret' }

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

test('a key lives in component state only: no storage, no address, no logging, no cookie; leaving the page drops it', () => {
  const source = readFileSync('app/components/credit-keys.jsx', 'utf8')
  // pagehide (also into the back-forward cache) clears it, flushed so the frozen page does not show it.
  assert.match(source, /addEventListener\('pagehide', drop\)/)
  assert.match(source, /const drop = \(\) => flushSync\(\(\) => \{ setFresh\(null\)/)
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
  assert.match(convert, /\{keysLink \? <>.*<a href="\/credits#keys"[^>]*>make a key on the credits page<\/a>.*<\/> : <>run <code>npx @repoing\/cli credits key<\/code> to make a key\.<\/>\}/,
    'the link only with keysLink; without it the CLI line as before')
  const claim = readFileSync('app/(site)/claim/[repo]/page.jsx', 'utf8')
  assert.match(claim, /creditsKeysLink=\{Boolean\(credits\) && creditKeysAvailable\(\)\}/, 'the claim page says whether /credits#keys exists')
  assert.match(readFileSync('app/components/claim-steps.jsx', 'utf8'), /keysLink=\{creditsKeysLink\}/)
})

test('the claim card links to /credits#keys only where that page and section exist: packs on, database, secret and a good AI gateway', async t => {
  const names = [...Object.keys(ON), 'CREDITS_INFERENCE_ORIGIN'], saved = Object.fromEntries(names.map(name => [name, process.env[name]])), savedPool = globalThis.__gitfunPool
  t.after(() => {
    for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name]
    if (savedPool === undefined) delete globalThis.__gitfunPool; else globalThis.__gitfunPool = savedPool
  })
  const available = extra => {
    for (const name of names) delete process.env[name]
    Object.assign(process.env, ON, extra)
    for (const [name, value] of Object.entries(extra)) if (value === undefined) delete process.env[name]
    return creditKeysAvailable()
  }
  assert.equal(available({}), true)
  assert.equal(available({ CREDITS_INFERENCE_ORIGIN: 'https://ai.example' }), true)
  // Conversion on and packs off is the case that used to link to a 404.
  for (const off of [{ CREDITS_WEB_PACKS_ENABLED: 'false' }, { CREDITS_WEB_PACKS_ENABLED: undefined }, { DATABASE_URL: undefined }, { GITHUB_APP_CLIENT_SECRET: undefined },
    { REPO_INFERENCE_HANDOFF_ENABLED: 'false' }, { CREDITS_INFERENCE_ORIGIN: 'http://ai.example' }]) {
    delete globalThis.__gitfunPool
    assert.equal(available(off), false, JSON.stringify(off))
  }
})
