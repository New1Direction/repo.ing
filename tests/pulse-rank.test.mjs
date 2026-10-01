import assert from 'node:assert/strict'
import test from 'node:test'
import { activeDevelopers, isBotAuthor, orderByShipping, pulseBadge, pulseListStatus, pulseScore, shippingLeaders } from '../app/lib/pulse-rank.mjs'
import { loadPulseIndex, summarizePulse } from '../app/lib/dev-pulse.mjs'

const NOW = Date.parse('2026-10-01T20:30:00Z'), HOUR = 3_600_000, DAY = 86_400_000
const iso = ms => new Date(ms).toISOString()
const pulse = (overrides = {}) => ({ commits24h: 0, commits7d: 0, merged7d: 0, releases7d: 0, devs7d: 0, lastCodeAt: iso(NOW - 2 * HOUR), ...overrides })

test('bots are not developers, and one person counts once whatever the letter case', () => {
  assert.ok(isBotAuthor('dependabot[bot]') && isBotAuthor('renovate-bot') && isBotAuthor('github-actions') && isBotAuthor(null))
  assert.equal(isBotAuthor('alice'), false)
  assert.equal(activeDevelopers([{ kind: 'commit', detail: 'Alice' }, { kind: 'merge', detail: 'alice' }, { kind: 'commit', detail: 'bob' },
    { kind: 'commit', detail: 'dependabot[bot]' }, { kind: 'release', detail: 'carol' }]), 2)
})

test('market rows say "N commits today" within a day, "Active this week" within seven, nothing after', () => {
  assert.deepEqual(pulseBadge(pulse({ commits24h: 34, commits7d: 149, merged7d: 15, devs7d: 6 }), NOW),
    { status: 'shipping', text: '34 commits today', title: 'Last 7 days: 149 commits, 15 merged pull requests, 0 releases · 6 developers' })
  assert.equal(pulseBadge(pulse({ commits24h: 1, commits7d: 1 }), NOW).text, '1 commit today')
  assert.equal(pulseBadge(pulse({ merged7d: 1 }), NOW).text, 'Shipped today')
  assert.equal(pulseBadge(pulse({ commits7d: 3, lastCodeAt: iso(NOW - 3 * DAY) }), NOW).text, 'Active this week')
  assert.equal(pulseBadge(pulse({ lastCodeAt: iso(NOW - 9 * DAY) }), NOW), null)
  assert.equal(pulseListStatus(null, NOW), null)
})

test('the Shipping order ranks code shipped this week, then developers, then volume; repos without a pulse go last', () => {
  const market = (mint, data, volume = '0') => ({ mint, repoId: mint, volume24hLamports: volume, pulse: data })
  const rows = orderByShipping([market('quiet', null, '900'), market('busy', pulse({ commits7d: 40, merged7d: 10 })),
    market('release', pulse({ commits7d: 5, releases7d: 2 })), market('teamA', pulse({ commits7d: 11, devs7d: 4 })), market('teamB', pulse({ commits7d: 11, devs7d: 1 }), '50')])
  assert.deepEqual(rows.map(row => row.mint), ['busy', 'teamA', 'teamB', 'release', 'quiet'])
  assert.equal(pulseScore(pulse({ commits7d: 5, merged7d: 2, releases7d: 1 })), 10)
})

test('home leaders skip $REPOING, do-not-promote and idle repositories', () => {
  const market = (mint, repoId, score) => ({ mint, repoId, volume24hLamports: '0', pulse: score ? pulse({ commits7d: score }) : null })
  const leaders = shippingLeaders([market('official', '1', 500), market('hidden', '2', 400), market('a', '3', 30), market('b', '4', 20), market('c', '5', 10), market('d', '6', 5), market('idle', '7', 0)],
    { excluded: new Set(['2']), skipMints: ['official'] })
  assert.deepEqual(leaders.map(row => row.mint), ['a', 'b', 'c'])
})

test('the token-page summary counts this week’s human developers', () => {
  const event = (kind, detail, hoursAgo) => ({ kind, sourceId: `${kind}${detail}${hoursAgo}`, at: iso(NOW - hoursAgo * HOUR), title: 'x', detail, url: null, amount: null })
  const summary = summarizePulse({ now: NOW, state: { fullName: 'o/r', stars: 1, checkedAt: iso(NOW) },
    events: [event('commit', 'alice', 1), event('commit', 'Alice', 30), event('merge', 'bob', 2), event('commit', 'dependabot[bot]', 3), event('commit', 'carol', 10 * 24)] })
  assert.equal(summary.devs7d, 2)
})

test('the list index turns one aggregate row per repository into badges and drops bot authors', async () => {
  const queries = []
  const pool = { async query(text, params) { queries.push(params); return { rows: [
    { repoId: '42', commits24h: 3, commits7d: 9, merged7d: 2, releases7d: 0, authors: ['alice', 'dependabot[bot]', 'bob'], lastCodeAt: new Date(NOW - HOUR) },
    { repoId: '43', commits24h: 0, commits7d: 0, merged7d: 0, releases7d: 0, authors: [], lastCodeAt: new Date(NOW - 10 * DAY) },
  ] } } }
  const index = await loadPulseIndex(pool, NOW)
  assert.deepEqual(queries[0], [iso(NOW - DAY), iso(NOW - 7 * DAY), iso(NOW - 14 * DAY), iso(NOW + 5 * 60_000)])
  assert.equal(index.get('42').devs7d, 2)
  assert.equal(index.get('42').badge.text, '3 commits today')
  assert.equal(index.get('43').badge, null)
  assert.deepEqual(await loadPulseIndex({ async query() { throw Object.assign(Error('missing'), { code: '42P01' }) } }, NOW), new Map())
})
