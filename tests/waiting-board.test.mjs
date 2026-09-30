import test from 'node:test'
import assert from 'node:assert/strict'
import { amountDisplay, claimPageUrl, recentlyClaimed, selectWaiting, tagIntentUrl, tagText, waitingAnchor, waitingRowUrl,
  waitingTotal, xWeightedLength, X_POST_LIMIT } from '../app/lib/waiting.mjs'

const SOL = 1_000_000_000n
function market(repoId, remainingSol, { wallet = null, verified = false, stars = 10, owner = 'acme' } = {}) {
  const remaining = String(BigInt(Math.round(remainingSol * 1000)) * SOL / 1000n)
  return { repoId: String(repoId), mint: `mint${repoId}`, owner, fullName: `${owner}/repo${repoId}`, symbol: `R${repoId}`, stars,
    earned: remaining, claimed: '0', remaining, beneficiaryWallet: wallet, wasVerified: verified }
}

test('selects unclaimed, unverified repositories with fees waiting, largest first', () => {
  const rows = selectWaiting([
    market(1, 2), market(2, 5), market(3, 0), market(4, 9, { wallet: 'Wallet1111' }),
    market(5, 7, { verified: true }), market(6, 0.5),
  ])
  assert.deepEqual(rows.map(r => r.repoId), ['2', '1', '6'])
})

test('never lists repositories whose maintainers asked not to be contacted', () => {
  const rows = selectWaiting([market(1, 3), market(2, 4)], { optedOut: new Set(['2']) })
  assert.deepEqual(rows.map(r => r.repoId), ['1'])
})

test('breaks amount ties by stars, then repository id, and honours the limit', () => {
  const rows = selectWaiting([market(3, 1, { stars: 5 }), market(1, 1, { stars: 5 }), market(2, 1, { stars: 50 }), market(4, 0.1)], { limit: 3 })
  assert.deepEqual(rows.map(r => r.repoId), ['2', '1', '3'])
})

test('ignores malformed or missing amounts instead of throwing', () => {
  const rows = selectWaiting([{ ...market(1, 1), remaining: 'NaN' }, { ...market(2, 1), remaining: undefined }, market(3, 1)])
  assert.deepEqual(rows.map(r => r.repoId), ['3'])
})

test('totals remaining lamports exactly', () => {
  assert.equal(waitingTotal([market(1, 1.5), market(2, 2.25)]), String(3_750_000_000n))
  assert.equal(waitingTotal([]), '0')
})

test('shows USD first with an approximate SOL line, and falls back to SOL without a price', () => {
  assert.deepEqual(amountDisplay(String(2n * SOL), 150), { value: '$300.00', sol: '≈ 2 SOL' })
  assert.deepEqual(amountDisplay(String(2n * SOL), null), { value: '2 SOL', sol: null })
})

test('builds claim and anchor links', () => {
  assert.equal(waitingAnchor('42'), 'repo-42')
  assert.equal(claimPageUrl('42'), 'https://repo.ing/claim/42')
  assert.equal(waitingRowUrl('42', 'http://localhost:3001'), 'http://localhost:3001/waiting#repo-42')
})

test('tag text names the GitHub owner without @, the amount and the repository', () => {
  const text = tagText({ owner: 'octocat', fullName: 'octocat/hello', amount: '$1,234.56' })
  assert.equal(text, 'octocat, you have $1,234.56 in builder fees waiting on repo.ing for octocat/hello. Verify with GitHub and claim 👉')
  assert.ok(!text.includes('@'))
})

test('X intent posts to the claim page in a new post and fits in 280 characters', () => {
  const url = new URL(tagIntentUrl({ repoId: '42', owner: 'octocat', fullName: 'octocat/hello', amount: '12.5 SOL' }))
  assert.equal(url.origin + url.pathname, 'https://x.com/intent/post')
  assert.equal(url.searchParams.get('url'), 'https://repo.ing/claim/42')
  assert.ok(url.searchParams.get('text').includes('12.5 SOL'))
  assert.ok(xWeightedLength(url.searchParams.get('text')) + 24 <= X_POST_LIMIT)
})

test('long repository names fall back to a shorter post that still fits', () => {
  const owner = 'o'.repeat(39), fullName = `${owner}/${'n'.repeat(100)}`
  const text = tagText({ owner, fullName, amount: '$123,456,789.00' })
  assert.ok(!text.includes(fullName))
  assert.ok(xWeightedLength(text) + 24 <= X_POST_LIMIT)
})

test('X weighting counts emoji and CJK as two characters', () => {
  assert.equal(xWeightedLength('ab'), 2)
  assert.equal(xWeightedLength('👉'), 2)
  assert.equal(xWeightedLength('日本'), 4)
})

test('recently claimed keeps the newest payout per market', () => {
  const payouts = [{ mint: 'a', signature: '1' }, { mint: 'b', signature: '2' }, { mint: 'a', signature: '3' }, { mint: null, signature: '4' }, { mint: 'c', signature: '5' }]
  assert.deepEqual(recentlyClaimed(payouts, 2).map(p => p.signature), ['1', '2'])
  assert.deepEqual(recentlyClaimed(payouts).map(p => p.signature), ['1', '2', '5'])
})
