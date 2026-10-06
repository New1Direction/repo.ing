import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { solGraduatedOutputs } from './fixtures/damm-trader-scenario.mjs'
import { publicMarketSQL } from '../src/graduation-readiness.mjs'
import { STOCK_MARKET_SQL } from '../src/stock-graduation-monitor.mjs'

// Golden tests for the SOL files the stock-pair graduation touched (docs/STOCK_QUOTES.md): their SOL behaviour is unchanged.
const golden = JSON.parse(readFileSync(new URL('./fixtures/damm-sol-golden.json', import.meta.url), 'utf8'))
const json = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v))

test('the SOL graduated trader quotes and prepares byte for byte as before the stock branch (tests/fixtures/damm-sol-golden.json)', async () => {
  // Recorded from src/canonical-damm-trade.mjs before createDammTrader dispatched stock-paired markets: same quotes, same
  // records, same transaction and message bytes, same referral, kept-WSOL and SOL trading fee fields.
  const outputs = json(await solGraduatedOutputs())
  assert.deepEqual(outputs, golden)
  assert.equal(outputs.buy.record.quoteMint, undefined, 'a SOL record still has no quote mint')
  assert.equal(outputs.buy.quoteMint, null)
})

test('the SOL graduation job lists exactly the markets it listed before, minus stock-paired and early access ones; the stock job lists only stock pairs', () => {
  const before = `select m.github_repo_id::text as "githubRepoId",m.mint,m.pool,m.creator_wallet as "creatorWallet",r.full_name as "fullName"
  from markets m join repositories r on r.github_repo_id=m.github_repo_id where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'`
  // Contributor early access markets (docs/EARLY_ACCESS.md) graduate through a transfer hook: neither job lists them yet.
  // Bundle markets (docs/BUNDLE_LAUNCH.md) graduate as SOL markets, read with their stamp (no partner claim for them).
  const withBundle = before.replace(',r.full_name', ',m.bundle_id::text as "bundleId",r.full_name')
  assert.equal(publicMarketSQL, `${withBundle} and m.quote_asset_id is null and m.early_access_end is null`)
  // The two lists split the same indexed markets on one column (tests/stock-graduation-db.test.mjs runs both on PostgreSQL).
  const where = sql => sql.slice(sql.indexOf(' where '))
  assert.equal(where(STOCK_MARKET_SQL), where(before) + ' and m.quote_asset_id is not null')
  assert.equal(where(publicMarketSQL).replace(/ is null and m\.early_access_end is null$/, ''), where(STOCK_MARKET_SQL).replace(/ is not null$/, ''))
})
