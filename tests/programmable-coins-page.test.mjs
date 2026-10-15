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
  assert.match(main, /href="\/coins\/new\?lane=programmable">Create a Programmable Coin draft/)
  assert.doesNotMatch(main, /<form\b|href="\/api\//)
  assert.equal(metadata.alternates.canonical, '/programmable-coins')
})

test('explicit Programmable entry shows wallet authority and blocked execution without a GitHub prerequisite', async () => {
  const { default: PlannerPage } = await appModule('app/(site)/coins/new/page.jsx')
  const markup = html(await PlannerPage({ searchParams: Promise.resolve({ lane: 'programmable' }) }), { wallet: true })
  assert.match(markup, /Configure your Programmable Coin/)
  assert.match(markup, /Connect launch wallet/)
  assert.match(markup, /public devnet checks still work/)
  assert.match(markup, /Optional GitHub account backup &amp; provenance/)
  assert.match(markup, /disabled=""[^>]*>Quote \/ simulate — unavailable/)
  assert.match(markup, /disabled=""[^>]*>Review &amp; sign — unavailable/)
  assert.match(markup, /repo-ing\/hook-lab-recipe\/1/)
  assert.match(markup, /Native guarded V2 and signed acceptance are required/)
  assert.doesNotMatch(markup, /sign in.*devnet checks/i)
  const standard = html(await PlannerPage({ searchParams: Promise.resolve({ lane: 'unrecognized' }) }), { wallet: true })
  assert.match(standard, /Configure your Standard Coin draft/)
  const { HookLabRecipePlanner } = await appModule('app/components/hook-lab-recipe-planner.jsx')
  const { defaultDirectPlan } = await import('../src/direct-coins.mjs')
  const old = { ...defaultDirectPlan('programmable'), name: 'Prior Coin', symbol: 'PRIOR' }
  const resumed = html(h(HookLabRecipePlanner, { legacyPlan: old, legacyDrafts: [{ id: 'older-account', plan: { ...old, name: 'Account Coin' } }] }), { wallet: true })
  assert.match(resumed, /Earlier Programmable drafts are still available/)
  assert.match(resumed, /Copy Prior Coin \(device\)/)
  assert.match(resumed, /Copy Account Coin \(account\)/)
})
