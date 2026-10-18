import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { HOOK_LAB_TEMPLATES } from '../src/hook-lab-templates.mjs'
import { existsSync } from 'node:fs'

test('Hooks discovery links to all draft templates without claiming live markets', async () => {
  const { default: Market } = await appModule('app/(site)/hooks/page.jsx')
  const { default: Templates } = await appModule('app/(site)/hooks/templates/page.jsx')
  const market = html(h(Market))
  assert.match(market, /Live markets are not available yet/)
  assert.match(market, /href="\/hooks\/templates"/)
  const templates = html(h(Templates))
  for (const template of HOOK_LAB_TEMPLATES) assert.ok(templates.includes(`href="/hooks/new?template=${template.id}"`))
  assert.equal((templates.match(/Draft only/g) ?? []).length, 5)
  assert.equal((templates.match(/Launch available/g) ?? []).length, 1)
  for (const template of HOOK_LAB_TEMPLATES) {
    assert.ok(templates.includes(`src="/hook-icons/${template.id}.webp"`), `${template.id} icon`)
    assert.ok(existsSync(new URL(`../public/hook-icons/${template.id}.webp`, import.meta.url)), `${template.id} icon file`)
  }
})

test('guided builder initializes every template without selecting editable economic values', async () => {
  const { default: Builder } = await appModule('app/(site)/hooks/new/page.jsx')
  for (const template of HOOK_LAB_TEMPLATES) {
    const markup = html(await Builder({ searchParams: Promise.resolve({ template: template.id }) }), { wallet: true })
    assert.match(markup, /Give your coin an identity/)
    assert.match(markup, /Not prepared/)
    assert.match(markup, /Unknown · not zero/)
    assert.ok(markup.includes(`&quot;template&quot;: &quot;${template.id}&quot;`))
    for (const type of template.requiredBlocks) assert.ok(markup.includes(`&quot;type&quot;: &quot;${type}&quot;`))
    if (template.id === 'burns') {
      assert.match(markup, /&quot;buy_bps&quot;: null/)
      assert.match(markup, /&quot;sell_bps&quot;: null/)
    }
    assert.doesNotMatch(markup, /Create or unlock local identities|Check simulation readiness/)
  }
  const invalid = html(await Builder({ searchParams: Promise.resolve({ template: 'not-supported' }) }), { wallet: true })
  assert.match(invalid, /&quot;template&quot;: &quot;plain&quot;/)
})

test('token addresses are not treated as verified coins and cannot trade', async () => {
  const { default: Token } = await appModule('app/(site)/hooks/token/[mint]/page.jsx')
  const mint = '11111111111111111111111111111111'
  for (const tab of ['market', 'rules']) {
    const markup = html(await Token({ params: Promise.resolve({ mint }), searchParams: Promise.resolve({ tab }) }))
    assert.match(markup, /Unverified coin/)
    assert.match(markup, /disabled=""[^>]*>Buy unavailable/)
    assert.match(markup, /disabled=""[^>]*>Sell unavailable/)
    assert.match(markup, tab === 'rules' ? /Rules and curve are unverified/ : /Market data unavailable/)
    assert.doesNotMatch(markup, /<canvas|<form/)
  }
  await assert.rejects(Token({ params: Promise.resolve({ mint: 'not-a-mint' }) }), /NEXT_HTTP_ERROR_FALLBACK;404/)
})

test('creator surface keeps recipe resume separate from read-only recovery', async () => {
  const { default: Mine } = await appModule('app/(site)/hooks/mine/page.jsx')
  const markup = html(h(Mine), { wallet: true })
  assert.match(markup, /href="\/hooks\/new"[^>]*>Resume draft/)
  assert.match(markup, /Refresh retained operations/)
  assert.match(markup, /cannot prepare, sign, submit or retry a transaction/)
  assert.match(markup, /A missing receipt is not proof/)
})
