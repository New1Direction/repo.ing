import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { earlyAccessNotice, fairRampNotice } from '../app/lib/early-access-display.mjs'
import { marketTokenMetrics, tokenAccountFilters } from '../app/lib/market-metrics.mjs'

const { EarlyAccessNote } = await appModule('app/components/early-access-note.jsx')
const NOW = Date.parse('2026-10-07T12:00:00Z'), HOOK = 'Ew1wqkFkxDADJi7iQnBTqy8fELDDotEeE8uzvg7TL6ep'
const market = end => ({ transferHookProgram: HOOK, earlyAccessEnd: end })

test('the early access notice shows only while the window is open, with its end in UTC', () => {
  assert.deepEqual(earlyAccessNotice(market('2026-10-07T12:15:00Z'), NOW), { endsAt: '2026-10-07T12:15:00.000Z', endsLabel: 'Oct 7, 12:15 UTC' })
  assert.equal(earlyAccessNotice(market(new Date('2026-10-08T09:05:00Z')), NOW).endsLabel, 'Oct 8, 09:05 UTC')
  // Graduated inside the window (step 7b): the filling swap revoked the hook, so anyone can buy and nothing is shown.
  for (const m of [market('2026-10-07T12:00:00Z'), market('2026-10-07T11:00:00Z'), market(null), { earlyAccessEnd: '2026-10-07T13:00:00Z' }, market('not a date'), null, {},
    { ...market('2026-10-07T12:15:00Z'), graduated: true }, { ...market('2026-10-07T12:15:00Z'), migrated: true }]) {
    assert.equal(earlyAccessNotice(m, NOW), null, JSON.stringify(m))
  }
})

test('the token page note: contributors who linked a wallet can buy until the end; anyone can sell', () => {
  const out = html(h(EarlyAccessNote, { market: market('2026-10-07T12:15:00Z'), now: NOW }))
  assert.match(out, /class="early-access-note"/)
  assert.match(out, /<time dateTime="2026-10-07T12:15:00.000Z">Oct 7, 12:15 UTC<\/time>/)
  assert.match(out, /only this repository(&#x27;|&apos;|')s contributors who linked a wallet can buy\. Anyone can sell\./)
  assert.match(out, /Contributor\? <a href="\/contributors\/link">Link your\s+wallet<\/a>\./)
  assert.equal(html(h(EarlyAccessNote, { market: market('2026-10-07T11:00:00Z'), now: NOW })), '')
  assert.equal(html(h(EarlyAccessNote, { market: { mint: 'x' }, now: NOW })), '')
})

test('the fair ramp note: on the curve, after the window too, with star unlocks when chosen; gone once the curve migrates', () => {
  const ended = rules => ({ ...market('2026-10-07T11:00:00Z'), hookRules: rules })
  assert.deepEqual(fairRampNotice(ended(3)), { ramp: { startPercent: 2, endPercent: 10, progressPercent: 50, firstBuyMaxBaseUnits: '20000000000000' } })
  assert.deepEqual(fairRampNotice(ended(7)).stars, { step: 100, bonusPercent: 0.5, maxPercent: 5 })
  for (const m of [ended(1), ended(null), { ...ended(3), graduated: true }, { ...ended(7), migrated: true }, { hookRules: 3 }, null]) {
    assert.equal(fairRampNotice(m), null, JSON.stringify(m))
  }
  const out = html(h(EarlyAccessNote, { market: { ...market('2026-10-07T12:15:00Z'), hookRules: 7 }, now: NOW }))
  assert.equal((out.match(/class="early-access-note"/g) ?? []).length, 2, 'the window and the ramp')
  assert.match(out, /<strong>Fair ramp<\/strong> · One wallet can hold at most 2% of\s+the supply at first, rising to 10% as the curve sells\. No limit from 50% curve progress\./)
  assert.match(out, /Star unlocks: every 100 new GitHub stars since the launch add 0\.5%, up\s+to 5%\./)
  const after = html(h(EarlyAccessNote, { market: ended(3), now: NOW }))
  assert.match(after, /Fair ramp/)
  assert.doesNotMatch(after, /Contributor early access|Star unlocks/)
})

test('holders of a Token-2022 mint are read from Token-2022 accounts by their account type, not their size', async () => {
  const mint = Keypair.generate().publicKey.toBase58()
  assert.deepEqual(tokenAccountFilters(mint, false), [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }])
  assert.deepEqual(tokenAccountFilters(mint, true), [{ memcmp: { offset: 0, bytes: mint } }, { memcmp: { offset: 165, bytes: '3' } }])
  const calls = []
  const connection = { rpcEndpoint: 'test', getTokenSupply: async () => ({ value: { amount: '1000', decimals: 6 } }),
    getProgramAccounts: async (program, options) => { calls.push([program.toBase58(), options.filters]); return [] } }
  for (const [token2022, program] of [[true, TOKEN_2022_PROGRAM_ID], [false, TOKEN_PROGRAM_ID]]) {
    const pool = Keypair.generate().publicKey.toBase58(), own = Keypair.generate().publicKey.toBase58()
    const metrics = await marketTokenMetrics(connection, own, pool, Date.now(), { token2022 })
    assert.equal(metrics.holders, 0)
    assert.equal(calls.at(-1)[0], program.toBase58())
  }
})
