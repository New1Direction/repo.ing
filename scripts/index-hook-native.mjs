// Owner-operated one batch only. No auto-migration, loop, general-worker registration or signer.
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { createHookIndexRpc, hookIndexManifestSchema, hookNativeIndexStore, indexHookNativeBatch } from '../src/hooklab-native-indexer.mjs'
import { productionHookEventDecoder } from '../src/hooklab-native-events.mjs'

if (process.argv.length !== 4 || process.argv[2] !== '--once') {
  console.error('Usage: node scripts/index-hook-native.mjs --once reviewed-manifest.json')
  process.exitCode = 2
} else {
  let pool
  try {
    const manifest = hookIndexManifestSchema.parse(JSON.parse(readFileSync(process.argv[3], 'utf8')))
    const urls = manifest.providers.map(p => process.env[`HOOK_INDEX_RPC_${p.toUpperCase().replaceAll('-', '_')}`])
    if (!process.env.HOOK_INDEX_DATABASE_URL || urls.some(u => !u) || new Set(urls.map(u => new URL(u).origin)).size !== 2) {
      throw Error('Explicit isolated database and distinct reviewed RPC origins required')
    }
    const adapters = manifest.providers.map((provider, i) => ({ provider, read: createHookIndexRpc(urls[i]) }))
    pool = new pg.Pool({ connectionString: process.env.HOOK_INDEX_DATABASE_URL, max: 1, connectionTimeoutMillis: 8000 })
    console.log(JSON.stringify(await indexHookNativeBatch({ manifest, adapters, store: hookNativeIndexStore(pool), decoder: productionHookEventDecoder({ sourceCommit: manifest.sourceCommit, sourcePatchSha256: manifest.sourcePatchSha256 }) })))
  } catch {
    // Driver/RPC errors may contain credentials; retain only the failure status here.
    console.error('Hook index batch failed or commit outcome unknown. Reread the stored checkpoint; review manifest, schema, archive coverage and provider agreement.')
    process.exitCode = 1
  } finally { if (pool) await pool.end() }
}
