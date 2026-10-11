import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html, offlineFetch, resolveServer } from './fixtures/render-jsx.mjs'

// The token page card for "every pack pays a builder" (app/components/pack-shares.jsx): dark unless switched on, only for a
// GitHub market in SOL, and it never needs the credit service's totals to show.
const { PackSharesCard } = await appModule('app/components/pack-shares.jsx')
const { PackSharesClaim } = await appModule('app/components/pack-shares-claim.jsx')

const ON = { REPO_INFERENCE_HANDOFF_ENABLED: 'true', REPO_INFERENCE_HANDOFF_SECRET: 'c'.repeat(40), HANDOFF_ASSERTION_SECRET: 'a'.repeat(40),
  CREDITS_WEB_PACKS_ENABLED: 'true', REPO_INFERENCE_CREDITS_ORIGIN: 'https://credits.repo.ing', CREDITS_TREASURY_ADDRESS: '11111111111111111111111111111111',
  CREDITS_WEB_BUILDER_SHARES_ENABLED: 'true', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', GITHUB_APP_CLIENT_SECRET: 'secret' }
const saved = Object.fromEntries(Object.keys(ON).map(key => [key, process.env[key]]))
const setEnv = values => { for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value }
const restore = () => setEnv(saved)
// Totals are kept a minute per repository in this process: every case uses its own repository.
const market = (repoId, extra = {}) => ({ repoId, fullName: `owner/repo-${repoId}`, source: 'github', quoteAssetId: null, quoteMint: null, ...extra })
const totals = (repoId, packs, paid) => [new RegExp(`/builder-shares/${repoId}$`), async () => Response.json({ repo_id: repoId, packs, paid_micro: paid, claimed_micro: 0 })]
const render = async element => html(await resolveServer(element))
const card = async (repo, routes) => {
  const fetches = offlineFetch(routes)
  try { return { markup: await render(await PackSharesCard({ market: repo })), requested: fetches.requested } } finally { fetches.restore() }
}

test('the card is dark unless builder shares and packs are switched on', async t => {
  t.after(restore)
  setEnv(ON)
  assert.match((await card(market('9101'), [totals('9101', 0, 0)])).markup, /AI credit packs back this repo/)
  for (const off of [{ CREDITS_WEB_BUILDER_SHARES_ENABLED: 'false' }, { CREDITS_WEB_PACKS_ENABLED: 'false' }, { DATABASE_URL: undefined }, { GITHUB_APP_CLIENT_SECRET: undefined }]) {
    setEnv({ ...ON, ...off })
    const dark = await card(market('9102'), [totals('9102', 3, 3_000_000)])
    assert.deepEqual([dark.markup, dark.requested], ['', []], JSON.stringify(off))
  }
})

test('only a GitHub market in SOL gets the card, and nothing is asked of the credit service for any other', async t => {
  t.after(restore)
  setEnv(ON)
  for (const other of [market('9103', { source: 'huggingface' }), market('9104', { quoteAssetId: 'asset:METAx' }), market('9105', { quoteMint: 'So11111111111111111111111111111111111111112' })]) {
    const none = await card(other, [totals(other.repoId, 1, 1_000_000)])
    assert.deepEqual([none.markup, none.requested], ['', []], other.repoId)
  }
})

test('the card says what the packs do, links to the pack shelf for this repository, and shows the total once there are packs', async t => {
  t.after(restore)
  setEnv(ON)
  const many = (await card(market('9106'), [totals('9106', 3, 7_500_000)])).markup
  assert.match(many, /10% of every pack opened for owner\/repo-9106 goes to its builders as AI credits\./)
  assert.match(many, /Paid so far: <strong>\$7\.50<\/strong> from 3 packs/)
  assert.match(many, /<a class="button outline" href="\/credits\?repo=9106">Open a pack for owner\/repo-9106<\/a>/)
  assert.match((await card(market('9107'), [totals('9107', 1, 1_000_000)])).markup, /from 1 pack</)
  const none = (await card(market('9108'), [totals('9108', 0, 0)])).markup
  assert.doesNotMatch(none, /Paid so far/)
  assert.match(none, /Open a pack for owner\/repo-9108/)
})

test('when the totals cannot be read, the card shows without its "Paid so far" line', async t => {
  t.after(restore)
  setEnv(ON)
  for (const [repoId, handler] of [['9109', async () => new Response('{}', { status: 502 })], ['9110', async () => { throw new TypeError('down') }],
    ['9111', async () => Response.json({ repo_id: '9111', packs: 2, paid_micro: 1, claimed_micro: 5 })]]) {
    const { markup } = await card(market(repoId), [[new RegExp(`/builder-shares/${repoId}$`), handler]])
    assert.match(markup, /Open a pack for owner\/repo-/)
    assert.doesNotMatch(markup, /Paid so far/)
  }
})

test('the claim section renders nothing until the signed-in payout holder has something to claim', () => {
  assert.equal(html(h(PackSharesClaim, { repoId: '1296269' })), '')
})
