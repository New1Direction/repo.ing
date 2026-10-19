import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { HOOK_LAB_TEMPLATES } from '../src/hook-lab-templates.mjs'
import { existsSync } from 'node:fs'

test('Hooks discovery keeps its drafts-only page until owner-approved launches open', async () => {
  const { default: Market } = await appModule('app/(site)/hooks/page.jsx')
  const market = html(h(Market))
  assert.match(market, /Live markets are not available yet/)
})

test('Blocks: two live blocks to launch with, four coming soon, each with its own icon; templates redirect here', async () => {
  const { default: Blocks } = await appModule('app/(site)/hooks/blocks/page.jsx')
  const { default: Templates } = await appModule('app/(site)/hooks/templates/page.jsx')
  const { HOOK_BLOCKS } = await import('../src/hooklab-blocks.mjs')
  const blocks = html(h(Blocks))
  assert.equal(HOOK_BLOCKS.length, 6)
  assert.equal((blocks.match(/>Live<\/span>/g) ?? []).length, 2)
  assert.equal((blocks.match(/>Soon<\/span>/g) ?? []).length, 4)
  for (const block of HOOK_BLOCKS) {
    assert.ok(blocks.includes(`src="${block.icon}"`), `${block.id} icon`)
    assert.ok(existsSync(new URL(`../public${block.icon}`, import.meta.url)), `${block.id} icon file`)
  }
  assert.match(blocks, /href="\/hooks\/launch-review"/)
  assert.doesNotMatch(blocks, /[Dd]raft|\/hooks\/new/)
  assert.throws(() => Templates(), error => /NEXT_REDIRECT|redirect/i.test(String(error?.digest ?? error?.message)))
})

test('the site header marks Hooks as new', async () => {
  const { AppHeader } = await appModule('app/components/ui.jsx')
  const header = html(h(AppHeader, { active: 'hooks' }), { wallet: true })
  assert.match(header, /Hooks<img class="nav-new-badge" src="\/badges\/new\.webp" alt=""/)
  assert.ok(existsSync(new URL('../public/badges/new.webp', import.meta.url)))
})

test('with owner-approved launches open, Hooks leads with launching and trading', async () => {
  const { default: Market } = await appModule('app/(site)/hooks/page.jsx')
  process.env.HOOK_OWNER_APPROVED_LAUNCHES = 'true'
  try {
    const market = html(h(Market))
    assert.match(market, /href="\/hooks\/launch-review">Launch a coin/)
    assert.match(market, /href="\/hooks\/trade">Buy &amp; sell/)
    assert.match(market, /You keep 75% of it, in SOL/)
    assert.doesNotMatch(market, /not available yet|not enabled|Execution unavailable/)
  } finally { delete process.env.HOOK_OWNER_APPROVED_LAUNCHES }
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
