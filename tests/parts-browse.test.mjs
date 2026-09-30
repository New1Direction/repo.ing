import test from 'node:test'
import assert from 'node:assert/strict'
import { PARTS_TABS, loadPartsLists, partsBrowseRow, partsBrowseView, partsTab, partsTabParam, relativeDay } from '../app/lib/parts-fund.mjs'

const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2026-09-30T12:00:00Z')
const at = days => new Date(NOW - days * DAY)
const row = (overrides = {}) => ({
  id: crypto.randomUUID(), repoId: '1', title: 'Robot arm', status: 'open', goalCents: 10_000, deadline: new Date(NOW + 10 * DAY),
  createdAt: at(3), closedAt: null, settledAt: null, fullName: 'acme/arm', mint: 'Mint111', symbol: 'ARM', openedBy: 'octo',
  maintainerWallet: 'Payout111', parts: 4, pledgedCents: '2500', backers: 3, backerWallets: ['A', 'B', 'C'], ...overrides,
})

test('?state= maps to a tab, defaulting to open for missing, repeated or unknown values', () => {
  assert.deepEqual(PARTS_TABS, ['open', 'funded', 'closed'])
  assert.equal(partsTabParam('funded'), 'funded')
  assert.equal(partsTabParam('closed'), 'closed')
  for (const value of [undefined, '', 'merged', ['funded', 'closed'], 'OPEN']) assert.equal(partsTabParam(value), 'open')
})

test('missed and cancelled lists share the Closed tab', () => {
  assert.deepEqual(['open', 'funded', 'failed', 'cancelled'].map(partsTab), ['open', 'funded', 'closed', 'closed'])
})

test('relative days read like an issue tracker, then fall back to a date', () => {
  assert.equal(relativeDay(at(0.2), NOW), 'today')
  assert.equal(relativeDay(new Date(NOW + 60_000), NOW), 'today')
  assert.equal(relativeDay(at(1.5), NOW), 'yesterday')
  assert.equal(relativeDay(at(3), NOW), '3 days ago')
  assert.equal(relativeDay(at(29.9), NOW), '29 days ago')
  assert.equal(relativeDay('2026-08-01T00:00:00Z', NOW), 'on Aug 1, 2026')
  assert.equal(relativeDay('not a date', NOW), '')
})

test('a row gets percent (floored, capped at 100), days left only while open, and numeric counts', () => {
  const open = partsBrowseRow(row(), NOW)
  assert.deepEqual([open.tab, open.percent, open.daysLeft, open.pledgedCents, open.goalCents, open.parts, open.backers], ['open', 25, 10, 2500, 10_000, 4, 3])
  assert.equal(open.createdAt, at(3).toISOString())
  assert.equal(partsBrowseRow(row({ pledgedCents: '9999' }), NOW).percent, 99)
  assert.equal(partsBrowseRow(row({ pledgedCents: '15000' }), NOW).percent, 100)
  // Partial days round up; a passed deadline awaiting its decision shows 0 (rendered as "closing").
  assert.equal(partsBrowseRow(row({ deadline: new Date(NOW + DAY / 2) }), NOW).daysLeft, 1)
  assert.equal(partsBrowseRow(row({ deadline: new Date(NOW - 60_000) }), NOW).daysLeft, 0)
  const funded = partsBrowseRow(row({ status: 'funded', closedAt: at(1), pledgedCents: '10000' }), NOW)
  assert.deepEqual([funded.tab, funded.percent, funded.daysLeft, funded.closedAt], ['funded', 100, null, at(1).toISOString()])
  const empty = partsBrowseRow(row({ pledgedCents: undefined, backers: undefined, parts: undefined, backerWallets: null, openedBy: undefined }), NOW)
  assert.deepEqual([empty.pledgedCents, empty.backers, empty.parts, empty.backerWallets, empty.openedBy], [0, 0, 0, [], null])
})

test('view: tab counts cover every list; the selected tab is sorted newest first', () => {
  const rows = [
    row({ id: 'open-old', createdAt: at(9) }), row({ id: 'open-new', createdAt: at(1) }),
    row({ id: 'funded', status: 'funded', createdAt: at(40), closedAt: at(2) }),
    row({ id: 'missed', status: 'failed', createdAt: at(50), closedAt: at(20) }),
    row({ id: 'cancelled', status: 'cancelled', createdAt: at(30), closedAt: at(5) }),
  ]
  const open = partsBrowseView(rows, undefined, NOW)
  assert.equal(open.state, 'open')
  assert.deepEqual(open.counts, { open: 2, funded: 1, closed: 2 })
  assert.deepEqual(open.lists.map(fund => fund.id), ['open-new', 'open-old'])
  // Closed lists sort by when they closed, not when they opened.
  assert.deepEqual(partsBrowseView(rows, 'closed', NOW).lists.map(fund => fund.id), ['cancelled', 'missed'])
  assert.deepEqual(partsBrowseView(rows, 'funded', NOW).lists.map(fund => fund.id), ['funded'])
  assert.deepEqual(partsBrowseView([], 'bogus', NOW), { state: 'open', counts: { open: 0, funded: 0, closed: 0 }, lists: [] })
})

test('loading: one query; a missing table (before migration 0033) is an empty list, other errors are reported unavailable', async () => {
  let queries = 0
  const ok = await loadPartsLists({ query: async sql => { queries += 1; assert.match(sql, /from parts_funds f/); return { rows: [row()] } } })
  assert.equal(queries, 1)
  assert.equal(ok.rows.length, 1)
  assert.deepEqual(await loadPartsLists({ query: async () => { throw Object.assign(Error('relation "parts_funds" does not exist'), { code: '42P01' }) } }), { rows: [] })
  const errors = console.error
  console.error = () => {}
  try {
    const down = await loadPartsLists({ query: async () => { throw Error('connection refused') } })
    assert.deepEqual(down.rows, [])
    assert.match(down.unavailable, /temporarily unavailable/)
  } finally { console.error = errors }
  assert.match((await loadPartsLists(null)).unavailable, /temporarily unavailable/)
})
