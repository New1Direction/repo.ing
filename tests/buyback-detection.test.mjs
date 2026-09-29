import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { detectBuyback } from '../src/buyback-detection.mjs'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { BUYBACK_RECEIPTS, BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'

// Raw mainnet getTransaction results (encoding json, maxSupportedTransactionVersion 1).
const TXS = JSON.parse(readFileSync(new URL('./fixtures/repoing-buyback-transactions.json', import.meta.url), 'utf8'))
const tx = prefix => structuredClone(TXS[Object.keys(TXS).find(signature => signature.startsWith(prefix))])
const team = { wallet: BUYBACK_WALLETS.team, source: 'team' }, custody = { wallet: BUYBACK_WALLETS.custody, source: 'custody' }
const strip = ({ slot, ...receipt }) => receipt

test('reproduces every hand-verified receipt exactly (legacy DBC and v1 DAMM, team and custody)', () => {
  for (const known of BUYBACK_RECEIPTS) {
    const raw = TXS[known.signature]
    const receipt = detectBuyback(raw, { wallet: known.wallet, source: known.source })
    assert.deepEqual(strip(receipt), { ...known }, known.signature)
    assert.equal(receipt.slot, String(raw.slot))
    assert.deepEqual(detectBuyback(normalizeFinalizedTransaction(raw, known.signature), { wallet: known.wallet, source: known.source }), receipt)
  }
  assert.deepEqual(new Set(BUYBACK_RECEIPTS.map(receipt => TXS[receipt.signature].version)), new Set(['legacy', 1]))
})

test('resolves v0 lookup-table keys in account order', () => {
  const raw = tx('QBN3'), keys = raw.transaction.message.accountKeys
  const expected = detectBuyback(raw, team)
  const moved = keys.splice(keys.length - 6)
  raw.version = 0
  raw.meta.loadedAddresses = { writable: moved.slice(0, 3), readonly: moved.slice(3) }
  assert.ok(moved.includes('9gu44zqNnRCxCt9jkrAmC3UBczYyuLbeJvGDsRJfYbur') || keys.includes('9gu44zqNnRCxCt9jkrAmC3UBczYyuLbeJvGDsRJfYbur'))
  assert.deepEqual(detectBuyback(raw, team), expected)
})

test('launch and early team buys are real buys but precede the buyback window', () => {
  for (const prefix of ['3tbwZgax', '3U4NMJFg', '23QNS75c']) assert.equal(detectBuyback(tx(prefix), team), null)
  // Same detector without the window reproduces the documented 0.856011397 SOL launch buy.
  assert.equal(detectBuyback(tx('3tbwZgax'), { ...team, since: '2026-01-01T00:00:00Z' }).spentLamports, '856011397')
})

test('lock deposits, fee claims, migrations and transfers are not buybacks', () => {
  for (const prefix of ['3NS1iyvL', 'RneC8L7H', '5LF5fNnd', '3VjtGmDd', '5MELU5Jc']) assert.equal(detectBuyback(tx(prefix), team), null, prefix)
  for (const prefix of ['4KhtxCgT', '2Pa5egfe']) assert.equal(detectBuyback(tx(prefix), custody), null, prefix)
})

test('fails closed on the wrong wallet, failures, non-signers, sells and vault outflows', () => {
  assert.equal(detectBuyback(tx('QBN3'), custody), null)
  const failed = tx('QBN3'); failed.meta.err = { InstructionError: [3, 'Custom'] }
  assert.equal(detectBuyback(failed, team), null)
  const unsigned = tx('QBN3'); unsigned.transaction.message.header.numRequiredSignatures = 0
  assert.equal(detectBuyback(unsigned, team), null)
  const unpaid = tx('QBN3'); unpaid.meta.postBalances[0] = unpaid.meta.preBalances[0]
  assert.equal(detectBuyback(unpaid, team), null)
  const index = raw => raw.transaction.message.accountKeys.indexOf('9gu44zqNnRCxCt9jkrAmC3UBczYyuLbeJvGDsRJfYbur')
  const outflow = tx('QBN3'), vault = outflow.meta.postTokenBalances.find(entry => entry.accountIndex === index(outflow))
  vault.uiTokenAmount.amount = '1'
  assert.equal(detectBuyback(outflow, team), null)
  // Wallet also moved REPOING out of one of its accounts: ambiguous, not a receipt.
  const mixed = tx('QBN3')
  mixed.meta.preTokenBalances.push({ accountIndex: 99, mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', owner: BUYBACK_WALLETS.team, uiTokenAmount: { amount: '5' } })
  assert.equal(detectBuyback(mixed, team), null)
  assert.equal(detectBuyback(null, team), null)
})
