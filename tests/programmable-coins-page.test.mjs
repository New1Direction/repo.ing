import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

const { default: Page, metadata } = await appModule('app/(site)/programmable-coins/page.jsx')

test('public programmable-coins page distinguishes planning from execution and directs early access to the existing planner', () => {
  const markup = html(h(Page), { wallet: true })
  const main = markup.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1]
  assert.match(main, /Experimental devnet beta · Preview only/)
  assert.match(main, /Launch or trade <span>Unavailable/)
  assert.match(main, /no executable transaction, quote, or simulation/)
  assert.match(main, /neither SPL nor Token-2022/)
  assert.match(main, /not a Hook Lab platform token/)
  assert.match(main, /bridge programs custody underlying assets/)
  assert.match(main, /not a user-selected LP burn/)
  assert.match(main, /Total debits, rent, minimum output, and quote expiry are unknown/)
  assert.match(main, /not a beta admission or launch reservation/)
  for (const recipe of ['PLAIN', 'KIT', 'HALF-LIFE']) assert.ok(main.includes(`/ ${recipe}`))
  assert.match(main, /href="#early-access">Explore early access/)
  assert.match(main, /id="early-access"/)
  assert.match(main, /href="\/coins\/new">Open coin planner/)
  assert.doesNotMatch(main, /<form\b|href="\/api\//)
  assert.equal(metadata.alternates.canonical, '/programmable-coins')
})
