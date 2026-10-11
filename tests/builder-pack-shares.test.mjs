import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BUILDER_SHARE_BPS, builderShareTarget, builderSharesSettings, shareMicro } from '../src/builder-pack-shares.mjs'

// Every pack pays a builder (src/builder-pack-shares.mjs): the switch, and which repositories a pack may be opened for.
const ON = { REPO_INFERENCE_HANDOFF_ENABLED: 'true', REPO_INFERENCE_HANDOFF_SECRET: 'c'.repeat(40), HANDOFF_ASSERTION_SECRET: 'a'.repeat(40),
  CREDITS_WEB_PACKS_ENABLED: 'true', REPO_INFERENCE_CREDITS_ORIGIN: 'https://credits.repo.ing', CREDITS_TREASURY_ADDRESS: '11111111111111111111111111111111',
  CREDITS_WEB_BUILDER_SHARES_ENABLED: 'true' }

test('dark unless switched on, with packs and the handoff on', () => {
  assert.deepEqual(builderSharesSettings(ON), { secret: 'a'.repeat(40), shareBps: BUILDER_SHARE_BPS })
  assert.equal(Number.isInteger(builderSharesSettings(ON).shareBps), true, 'the credit service takes an integer')
  assert.equal(builderSharesSettings({ ...ON, CREDITS_WEB_BUILDER_SHARES_ENABLED: '1' }), null)
  assert.equal(builderSharesSettings({ ...ON, CREDITS_WEB_PACKS_ENABLED: 'false' }), null)
  assert.equal(builderSharesSettings({ ...ON, REPO_INFERENCE_HANDOFF_ENABLED: 'false' }), null)
  assert.equal(builderSharesSettings({}), null)
})

test('10% of a pack, rounded down to a micro-USD', () => {
  assert.equal(BUILDER_SHARE_BPS, 1000)
  assert.deepEqual([10_000_000, 25_000_000, 50_000_000, 100_000_000].map(pack => shareMicro(pack, BUILDER_SHARE_BPS)), [1_000_000, 2_500_000, 5_000_000, 10_000_000])
  assert.equal(shareMicro('25000000', 1000), 2_500_000)
  assert.equal(shareMicro(10_000_001, 1000), 1_000_000)
})

// One read decides; the fake pool answers it.
const pool = row => ({ query: async () => ({ rows: row ? [row] : [] }) })
const market = (extra = {}) => ({ repoId: '1296269', fullName: 'octo/hello', source: 'github', status: 'confirmed', indexed: true,
  launchFinality: 'finalized', quoteAssetId: null, quoteMint: null, holder: '900', declined: false, ...extra })

test('only a GitHub repository with a live SOL market, no opt-out, and a buyer who does not hold its payout wallet', async () => {
  assert.deepEqual(await builderShareTarget(pool(market()), { repoId: '1296269', buyerGithubUserId: '583231' }), { repoId: '1296269', fullName: 'octo/hello' })
  assert.deepEqual(await builderShareTarget(pool(market({ holder: null })), { repoId: '1296269', buyerGithubUserId: '583231' }),
    { repoId: '1296269', fullName: 'octo/hello' }, 'no maintainer yet: shares wait for one')
  const refused = async (row, pattern, repoId = '1296269') => assert.rejects(builderShareTarget(pool(row), { repoId, buyerGithubUserId: '583231' }),
    error => error.status === 400 && pattern.test(error.message))
  await refused(null, /no market on repo\.ing/)
  await refused(market({ status: 'submitted' }), /no market on repo\.ing/)
  await refused(market({ indexed: false }), /no market on repo\.ing/)
  await refused(market({ launchFinality: 'confirmed' }), /no market on repo\.ing/)
  await refused(market({ quoteAssetId: 'METAx' }), /stock pair/i)
  await refused(market({ quoteMint: 'Mint111' }), /stock pair/i)
  await refused(market({ declined: true }), /opted out/)
  await refused(market({ holder: '583231' }), /your own packs/)
  await refused(market(), /GitHub repositories/, '4503599627370497')
  await refused(market(), /GitHub repositories/, 'abc')
})

test('a bad repository id is refused before any read', async () => {
  const reads = []
  const counted = { query: async (...args) => { reads.push(args); return { rows: [market()] } } }
  for (const repoId of [undefined, null, '', '0', '012', '1.5', '-1', 1296269.5, '1'.repeat(20)]) {
    await assert.rejects(builderShareTarget(counted, { repoId, buyerGithubUserId: '1' }), error => error.status === 400 && /GitHub repositories/.test(error.message), String(repoId))
  }
  assert.deepEqual(reads, [])
  await builderShareTarget(counted, { repoId: 1296269, buyerGithubUserId: 1 })
  assert.equal(reads.length, 1, 'one read for a good id')
  assert.deepEqual(reads[0][1], ['1296269'])
})

test('migration 0069 only adds the pack builder columns and their check, comes after every earlier migration, and is declared in the schema', () => {
  const sql = readFileSync('drizzle/0069_pack_builder_shares.sql', 'utf8')
  assert.match(sql, /ALTER TABLE "credit_pack_purchases" ADD COLUMN IF NOT EXISTS "builder_repo_id" bigint;/)
  assert.match(sql, /ALTER TABLE "credit_pack_purchases" ADD COLUMN IF NOT EXISTS "builder_share_bps" integer;/)
  assert.match(sql, /CHECK \(\("builder_repo_id" IS NULL\) = \("builder_share_bps" IS NULL\)/)
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|DROP|CREATE TABLE)\b|NOT NULL/i, 'expand-only: nothing is rewritten, no old row is refused')
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  const last = entries.at(-1)
  assert.equal(last.tag, '0069_pack_builder_shares')
  assert.equal(last.idx, entries.at(-2).idx + 1)
  assert.ok(entries.slice(0, -1).every(entry => entry.when < last.when))
  const schema = readFileSync('src/db/schema.mjs', 'utf8')
  for (const name of ['builder_repo_id', 'builder_share_bps', 'credit_pack_purchases_builder_check']) assert.ok(schema.includes(`'${name}'`), name)
})
