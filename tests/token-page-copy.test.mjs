import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { OFFICIAL_TEAM_LOCKS, stillLockedBaseUnits } from '../app/lib/official-team-locks.mjs'

// The token page's "less is more" display rules: no zero tiles, no raw commit messages, no "0 SOL" volume, and one
// locked figure that the Token locks list and Launch facts share.
const { TeamTokenLocks } = await appModule('app/components/team-token-locks.jsx')
const { DevPulse } = await appModule('app/components/dev-pulse.jsx')
const { DevPulseStrip } = await appModule('app/components/dev-pulse-strip.jsx')
const { MoreMarkets } = await appModule('app/components/more-markets.jsx')

const NOW = Date.parse('2026-10-29T12:00:00Z')
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ')

test('token locks: the still-locked share on top, one compact row per lock, terms folded', () => {
  const markup = html(h(TeamTokenLocks, { now: NOW }))
  assert.match(text(markup), /176\.1M \$REPOING in 10 Jupiter locks/)
  assert.match(text(markup), /17% of supply locked/, 'deposits less the releases already due, as Launch facts shows it')
  assert.equal((markup.match(/class="team-locks-row"/g) ?? []).length, OFFICIAL_TEAM_LOCKS.length)
  assert.match(text(markup), /Team bought-back REPOING 3 1\.1% of supply 11\.1M/)
  assert.match(markup, /<details class="team-locks-details"><summary>Lock details<\/summary>/)
  assert.match(text(markup), /Two locks are original team deposits/, 'the provenance note is folded, not deleted')
  assert.doesNotMatch(text(markup), /of fixed supply|17\.61%/)
})

test('still locked: every lock, less the releases already due', () => {
  const before = Date.parse('2026-10-01T00:00:00Z')
  assert.equal(stillLockedBaseUnits(before), 176_111_111n * 1_000_000n)
  assert.equal(stillLockedBaseUnits(Date.parse('2027-03-01T00:00:00Z')), 0n)
  assert.ok(stillLockedBaseUnits(NOW) < 176_111_111n * 1_000_000n)
})

const pulse = { status: 'quiet', lastCodeAt: new Date(NOW - 9 * 86_400_000).toISOString(), commits24h: 0, commits7d: 0, devs7d: 0, merged7d: 0,
  release: null, stars: { total: 3, today: 0, partial: false }, hn: null, checkedAt: new Date(NOW - 7 * 86_400_000).toISOString(),
  maintainer: { verified: true, since: '2026-09-27T00:00:00Z', claimHref: '/claim/1' },
  days: [{ day: '2026-10-20', commits: 13 }, { day: '2026-10-29', commits: 0 }],
  feed: [
    { id: 'paid:a', kind: 'paid', at: new Date(NOW - 18 * 60_000).toISOString(), title: 'Builder claimed 0.05 SOL', detail: 'Fees paid to the verified payout wallet', url: 'https://solscan.io/tx/a' },
    { id: 'merge:329', kind: 'merge', at: new Date(NOW - 9 * 86_400_000).toISOString(), title: '#329 fix: DBC builder collections count only DBC collections', detail: null, url: 'https://github.com/o/r/pull/329' },
    { id: 'commits:1', kind: 'commits', at: new Date(NOW - 9 * 86_400_000).toISOString(), title: '7 commits', detail: 'fix(e2e): after the admin reopens launches or trading', url: 'https://github.com/o/r/commit/1' },
    { id: 'commits:2', kind: 'commits', at: new Date(NOW - 9 * 86_400_000).toISOString(), title: '2 commits', detail: 'fix(hooks): launch settlement', url: 'https://github.com/o/r/commit/2' },
  ] }

test('dev pulse: no zero tiles, no total stars (the hero has them), at most three short feed lines, no stale "checked"', () => {
  const markup = text(html(h(DevPulse, { mint: 'M', initial: pulse, repoUrl: 'https://github.com/o/r' })))
  assert.doesNotMatch(markup, /commits today|developers this week|None yet|latest release|PRs merged|\bstars\b/)
  assert.match(markup, /Verified maintainer on repo\.ing/)
  assert.match(markup, /Builder claimed 0\.05 SOL/)
  assert.match(markup, /Merged pull request #329/)
  assert.doesNotMatch(markup, /fix\(|fix:|Fees paid to the verified payout wallet/, 'no raw commit messages or detail lines')
  assert.doesNotMatch(markup, /2 commits/, 'three feed items at most')
  assert.doesNotMatch(markup, /checked/)
  assert.equal((markup.match(/Quiet · last activity/g) ?? []).length, 1)
  assert.equal(html(h(DevPulseStrip, { pulse, now: NOW })), '', 'the hero strip does not repeat a quiet status')
  assert.match(html(h(DevPulseStrip, { pulse: { ...pulse, status: 'active', commits7d: 4 }, now: NOW })), /4 commits this week/)
})

test('dev pulse: shipping repositories keep their tiles', () => {
  const markup = text(html(h(DevPulse, { mint: 'M', initial: { ...pulse, status: 'shipping', commits24h: 5, commits7d: 12, devs7d: 2, merged7d: 1,
    stars: { total: 40, today: 6, partial: false } }, repoUrl: 'https://github.com/o/r' })))
  assert.match(markup, /5 commits today 12 this week/)
  assert.match(markup, /2 developers this week/)
  assert.match(markup, /\+6 stars today/)
  assert.match(markup, /1 PR merged this week/)
})

test('more markets: a quiet market shows no "0 SOL" volume line', () => {
  const market = (n, volume) => ({ repoId: String(n), mint: `mint${n}`, fullName: `o/r${n}`, symbol: `S${n}`, volume24hLamports: volume, isNew: false })
  const markup = text(html(h(MoreMarkets, { markets: [market(1, '74790000000'), market(2, '0'), market(3, '99')] })))
  assert.match(markup, /24h vol 74\.79 SOL/)
  assert.equal((markup.match(/24h vol/g) ?? []).length, 1)
  assert.doesNotMatch(markup, /0 SOL|<0\.000001/)
})
