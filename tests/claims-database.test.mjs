import test from 'node:test'
import assert from 'node:assert/strict'
import { claimsDatabase } from '../app/lib/server.mjs'

// Claim, binding and GitHub-verification writes get their own pool, and only for the dedicated claims role over verified TLS.
test('claimsDatabase accepts only repoing_builder_claims with sslmode=verify-full', () => {
  const saved = process.env.CLAIMS_DATABASE_URL
  try {
    for (const refused of [undefined, '', 'not a url', 'mysql://repoing_builder_claims:x@h/d?sslmode=verify-full',
      'postgres://repoing_existing_market_trader:x@h/repoing_operational?sslmode=verify-full',
      'postgres://repoing_owner:x@h/repoing_operational?sslmode=verify-full',
      'postgres://repoing_builder_claims:x@h/repoing_operational?sslmode=require',
      'postgres://repoing_builder_claims:x@h/repoing_operational']) {
      if (refused === undefined) delete process.env.CLAIMS_DATABASE_URL; else process.env.CLAIMS_DATABASE_URL = refused
      assert.equal(claimsDatabase(), null, String(refused))
    }
    process.env.CLAIMS_DATABASE_URL = 'postgres://repoing_builder_claims:x@127.0.0.1:1/repoing_operational?sslmode=verify-full'
    const pool = claimsDatabase()
    assert.ok(pool && typeof pool.query === 'function')
    assert.equal(claimsDatabase(), pool, 'one pool per process')
    pool.end?.()
  } finally {
    if (saved === undefined) delete process.env.CLAIMS_DATABASE_URL; else process.env.CLAIMS_DATABASE_URL = saved
    delete globalThis.__repoingClaimsPool
  }
})
