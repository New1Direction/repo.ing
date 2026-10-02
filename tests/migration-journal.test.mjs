import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

// drizzle's migrator applies only journal entries whose "when" is later than the last migration a database applied, so an
// entry appended out of order is skipped without an error. This runs in the required quick tests (the full upgrade is
// tests/graduation-migration.test.mjs); merge order across branches must still put a lower "when" first.
test('migrations are journaled once each, in increasing idx and "when" order', () => {
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  entries.forEach((entry, i) => {
    assert.match(entry.tag, new RegExp(`^${String(entry.idx).padStart(4, '0')}_[a-z0-9_]+$`), `${entry.tag} matches idx ${entry.idx}`)
    if (i) {
      assert.ok(entry.idx > entries[i - 1].idx, `${entry.tag} comes after ${entries[i - 1].tag}`)
      assert.ok(entry.when > entries[i - 1].when, `${entry.tag} must have a later "when" than ${entries[i - 1].tag}`)
    }
  })
  const files = readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()
  assert.deepEqual(files, entries.map(entry => `${entry.tag}.sql`).sort(), 'every migration file is journaled, and every entry has a file')
})
