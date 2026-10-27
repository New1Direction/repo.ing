import test from 'node:test'
import assert from 'node:assert/strict'
import { problems, decide, STALE_MS, REMIND_MS } from '../scripts/ops-monitor.mjs'

const now = Date.parse('2026-10-27T15:00:00Z')
const healthy = { now, chartObservedAt: now - 60_000, feeBehind: { count: 0, oldest: null } }

test('a healthy reading raises nothing', () => {
  assert.deepEqual(problems(healthy), [])
})

test('a chart writer silent for over 10 minutes is a problem; under 10 is not', () => {
  assert.deepEqual(problems({ ...healthy, chartObservedAt: now - STALE_MS + 1000 }), [])
  const [p] = problems({ ...healthy, chartObservedAt: now - 11 * 60_000 })
  assert.equal(p.key, 'chart-stale')
  assert.match(p.text, /11 minutes/)
  assert.equal(problems({ ...healthy, chartObservedAt: null })[0].key, 'chart-stale')
})

test('missed fee trades, safety stops and quotas past 80% are each reported', () => {
  const keys = problems({ ...healthy, feeBehind: { count: 3, oldest: now - 25 * 60_000 }, stops: ['chart writer'],
    quotas: [{ name: 'compute hours', used: 81, limit: 100 }, { name: 'storage', used: 79, limit: 100 }, { name: 'data transfer', used: 5, limit: 0 }] })
    .map(p => p.key)
  assert.deepEqual(keys, ['fee-stale', 'stop:chart writer', 'quota:compute hours'])
})

test('an unreachable database is reported alone, with only its error code', () => {
  const found = problems({ now, db: { error: 'code 53000' } })
  assert.deepEqual(found.map(p => p.key), ['database'])
  assert.match(found[0].text, /code 53000/)
})

test('one push when a problem starts, a reminder after 2 hours, one when it clears', () => {
  const stale = [{ key: 'chart-stale', text: 'x' }]
  const first = decide({}, stale, now)
  assert.equal(first.pushes.length, 1)
  assert.equal(decide(first.state, stale, now + 60_000).pushes.length, 0)
  const reminder = decide(first.state, stale, now + REMIND_MS)
  assert.equal(reminder.pushes[0].title, 'repo.ing still broken')
  const cleared = decide(reminder.state, [], now + REMIND_MS + 60_000)
  assert.equal(cleared.pushes[0].title, 'repo.ing recovered')
  assert.deepEqual(cleared.state.open, {})
})
