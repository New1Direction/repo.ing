import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { hookNativeIndexStore, indexHookNativeBatch } from '../src/hooklab-native-indexer.mjs'
import { readNativeReceiptPage } from '../src/hooklab-native-reads.mjs'
import { nativeIndexFixture } from './fixtures/hooklab-native-index.mjs'
import { decodedNativeFixture } from './fixtures/hooklab-native-read.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

test('isolated PostgreSQL reads checkpointed raw/decoded rows, resumes pages and refuses corrupted evidence', async () => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config), database = `native_reads_${randomUUID().replaceAll('-', '')}`
  let writer, reader
  try {
    await admin.query(`create database ${database}`)
    writer = new pg.Pool({ ...config, database })
    reader = new pg.Pool({ ...config, database, options: '-c default_transaction_read_only=on' })
    await writer.query(readFileSync(new URL('../src/hooklab-native-index-schema.sql', import.meta.url), 'utf8'))
    const f = nativeIndexFixture()
    await indexHookNativeBatch({ ...f, store: hookNativeIndexStore(writer) })
    const first = await readNativeReceiptPage({ pool: reader, manifest: f.manifest, query: { limit: 1 } })
    assert.equal(first.entries[0].slot, 100); assert.ok(first.nextCursor)
    await reader.end(); reader = new pg.Pool({ ...config, database, options: '-c default_transaction_read_only=on' })
    const second = await readNativeReceiptPage({ pool: reader, manifest: f.manifest, query: { limit: 1, cursor: first.nextCursor } })
    assert.equal(second.entries[0].slot, 102); assert.equal(second.nextCursor, null)
    await assert.rejects(reader.query('delete from hook_native_index_transactions'), /read-only/)
    assert.equal((await writer.query('select count(*) from hook_native_index_transactions')).rows[0].count, '2')
    const decoded = decodedNativeFixture()
    await indexHookNativeBatch({ ...decoded, store: hookNativeIndexStore(writer) })
    const page = await readNativeReceiptPage({ pool: reader, manifest: decoded.manifest })
    assert.equal(page.entries[0].events[0].data.quote_amount, '9007199254740993')
    assert.equal(page.entries[0].deploymentAdopted, false); assert.equal(page.entries[0].economicPostconditions, false)
    await writer.query(`update hook_native_index_transactions set evidence=jsonb_set(evidence,'{deploymentAdopted}','true') where stream=$1`, [page.identity.stream])
    await assert.rejects(readNativeReceiptPage({ pool: reader, manifest: decoded.manifest }))
    assert.equal((await writer.query('select count(*) from hook_native_index_transactions')).rows[0].count, '3')
  } finally {
    if (reader) await reader.end(); if (writer) await writer.end()
    await dropTestDatabase(admin, database); await admin.end()
  }
})
