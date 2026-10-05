import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { BUYBACK_IMPORT_REFUSALS, createPlatformRevenue } from '../src/platform-revenue.mjs'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { BUYBACK_RECEIPTS, BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'

// Recording a buyback by hand (importBuyback) against real mainnet transactions: raw getTransaction results (encoding
// json, maxSupportedTransactionVersion 1), handed over the way loadFinalizedTransaction hands them to the worker.
const TXS = JSON.parse(readFileSync(new URL('./fixtures/repoing-buyback-transactions.json', import.meta.url), 'utf8'))
const signatureOf = prefix => Object.keys(TXS).find(signature => signature.startsWith(prefix))
const GROUP = '11111111-2222-3333-4444-555555555555'
const connection = { rpcEndpoint: 'http://rpc.invalid' }
const custodyBuys = BUYBACK_RECEIPTS.filter(receipt => receipt.source === 'custody')

// A ledger with one allocation group whose buyback share has `remaining` lamports left.
function ledger({ remaining = 10_000_000_000n, group = GROUP, recorded = false } = {}) {
  const statements = [], inserted = []
  let released = 0
  const query = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim()
    statements.push(text)
    if (/pg_advisory_(un)?lock/.test(text)) return { rows: [] }
    if (/^select allocation_group from platform_revenue_allocations order by created_at desc limit 1/.test(text)) return { rows: group ? [{ allocation_group: group }] : [] }
    if (/^select policy_version from platform_revenue_allocations where allocation_group=\$1/.test(text)) return { rows: params[0] === group ? [{ policy_version: 1 }] : [] }
    if (/sum\(buyback_amount\)/.test(text)) return { rows: [{ buyback: String(remaining) }] }
    if (/sum\(amount\).* as assigned/.test(text)) return { rows: [{ assigned: '0' }] }
    if (/^insert into buyback_intents/.test(text)) {
      if (recorded) return { rows: [] }
      inserted.push(params)
      return { rows: [{ id: 1, idempotencyKey: params[0], amount: params[2], status: 'settled', signature: params[10] }] }
    }
    throw new Error(`unexpected statement: ${text}`)
  }
  return { statements, inserted, released: () => released, query, connect: async () => ({ query, release() { released += 1 } }) }
}
const reader = (edit = tx => tx) => {
  const read = []
  return Object.assign(async (rpc, signature) => {
    read.push([rpc, signature])
    const raw = TXS[signature]
    return raw ? normalizeFinalizedTransaction(edit(structuredClone(raw)), signature) : null
  }, { read })
}
const importer = ({ pool = ledger(), wallet = BUYBACK_WALLETS.custody, loadTransaction = reader() } = {}) => ({ pool, loadTransaction,
  record: (signature, extra = {}) => createPlatformRevenue({ pool, partnerWallet: new PublicKey(wallet) }).importBuyback({ signature, allocationGroup: null,
    createdBy: '123', connection, mint: OFFICIAL_TOKEN.mint, loadTransaction, ...extra }) })

test('a custody buy is recorded with the same figures the worker publishes for it', async () => {
  assert.equal(custodyBuys.length, 4)
  for (const known of custodyBuys) {
    const { pool, record, loadTransaction } = importer()
    const intent = await record(known.signature)
    assert.equal(intent.amount, known.spentLamports, 'the swap input, as on the published receipt')
    assert.deepEqual(loadTransaction.read, [[connection, known.signature]])
    const [key, group, amount, wallet, mint, tokenAccount, output, policy, review, blockTime, signature, createdBy] = pool.inserted[0]
    assert.equal(key, `import.${known.signature.slice(0, 56)}`)
    assert.ok(key.length <= 64, 'fits buyback_intents.idempotency_key')
    assert.deepEqual([group, amount, wallet, mint, output, policy, signature, createdBy],
      [GROUP, known.spentLamports, BUYBACK_WALLETS.custody, OFFICIAL_TOKEN.mint, known.tokenBaseUnits, 1, known.signature, '123'])
    // The destination is the custody wallet's own account of the token, the one that received the purchase.
    const raw = TXS[known.signature], entry = raw.meta.postTokenBalances.find(balance => raw.transaction.message.accountKeys[balance.accountIndex] === tokenAccount)
    assert.deepEqual([entry.owner, entry.mint], [BUYBACK_WALLETS.custody, OFFICIAL_TOKEN.mint])
    assert.equal(new Date(blockTime * 1000).toISOString(), known.at)
    assert.deepEqual(JSON.parse(review), { purpose: 'manual-buyback-import', importedBy: '123', signature: known.signature, source: 'operator-executed swap' })
    assert.equal(pool.released(), 1)
    assert.match(pool.statements.at(-1), /pg_advisory_unlock/)
  }
})

test('the spend is what went into the swap: a tip, rent for a new account and the network fee are not buyback spend', async () => {
  const known = custodyBuys[0]
  // The wallet's own SOL fell by a further 0.012 SOL in the same transaction.
  const { record } = importer({ loadTransaction: reader(tx => { tx.meta.preBalances[0] += 12_039_280; return tx }) })
  assert.equal((await record(known.signature)).amount, known.spentLamports)
})

test('legacy, v0 with lookup tables and v1 transactions are all read', async () => {
  const versions = new Set()
  // The team wallet's legacy and v1 buys, recorded by a ledger whose buyback wallet it is.
  for (const known of BUYBACK_RECEIPTS.filter(receipt => receipt.source === 'team')) {
    versions.add(TXS[known.signature].version)
    assert.equal((await importer({ wallet: BUYBACK_WALLETS.team }).record(known.signature)).amount, known.spentLamports)
  }
  assert.deepEqual(versions, new Set(['legacy', 1]))
  // The same custody buy as a v0 transaction: its last six accounts come from an address lookup table.
  const known = custodyBuys[0]
  const asV0 = tx => {
    const moved = tx.transaction.message.accountKeys.splice(-6)
    return Object.assign(tx, { version: 0, meta: { ...tx.meta, loadedAddresses: { writable: moved.slice(0, 3), readonly: moved.slice(3) } } })
  }
  const plain = importer(), tabled = importer({ loadTransaction: reader(asV0) })
  await plain.record(known.signature)
  assert.equal((await tabled.record(known.signature)).amount, known.spentLamports)
  assert.deepEqual(tabled.pool.inserted, plain.pool.inserted, 'the same row, destination account included')
})

test('anything the worker would not publish as a custody buyback is refused before the ledger is touched', async () => {
  const refused = async (signature, options, reason = BUYBACK_IMPORT_REFUSALS.notBuyback) => {
    const { pool, record } = importer(options)
    await assert.rejects(record(signature), { message: reason }, signature)
    assert.deepEqual(pool.statements, [], 'no lock is taken and nothing is written')
  }
  // The custody and fee wallets' own transfers and deposits.
  await refused(signatureOf('2Pa5egfe'))
  await refused(signatureOf('4KhtxCgT'), { wallet: 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3' })
  // A real buy, by another wallet.
  await refused(BUYBACK_RECEIPTS.find(receipt => receipt.source === 'team').signature)
  // The same buy with the tokens also leaving one of the wallet's accounts: ambiguous, so not a receipt.
  await refused(custodyBuys[0].signature, { loadTransaction: reader(tx => {
    tx.meta.preTokenBalances.push({ accountIndex: 99, mint: OFFICIAL_TOKEN.mint, owner: BUYBACK_WALLETS.custody, uiTokenAmount: { amount: '5' } })
    return tx
  }) })
  // A failed transaction, and one the chain does not have.
  await refused(custodyBuys[0].signature, { loadTransaction: reader(tx => { tx.meta.err = { InstructionError: [3, 'Custom'] }; return tx }) }, BUYBACK_IMPORT_REFUSALS.unfinalized)
  await refused('5'.repeat(88), {}, BUYBACK_IMPORT_REFUSALS.unfinalized)
})

test('a malformed signature is refused before anything is read', async () => {
  for (const signature of ['not-a-signature', '', null, undefined, `${custodyBuys[0].signature}0`]) {
    const { pool, record, loadTransaction } = importer()
    await assert.rejects(record(signature), { message: BUYBACK_IMPORT_REFUSALS.signature })
    assert.deepEqual([loadTransaction.read, pool.statements], [[], []])
  }
})

test('a chain read that fails says so in fixed words, and no lock is taken', async () => {
  const pool = ledger()
  const loadTransaction = async () => { throw new Error('Solana RPC transaction read returned HTTP 429: {"secret":"provider text"}') }
  await assert.rejects(importer({ pool, loadTransaction }).record(custodyBuys[0].signature), error => {
    assert.equal(error.message, BUYBACK_IMPORT_REFUSALS.unread)
    assert.match(error.cause.message, /HTTP 429/)
    return true
  })
  assert.deepEqual(pool.statements, [])
})

test('a buy larger than the allocation has left for buybacks is refused, and the ledger lock is released', async () => {
  const known = custodyBuys[0], pool = ledger({ remaining: BigInt(known.spentLamports) - 1n })
  await assert.rejects(importer({ pool }).record(known.signature), { message: BUYBACK_IMPORT_REFUSALS.reserve })
  assert.deepEqual(pool.inserted, [])
  assert.match(pool.statements.at(-1), /pg_advisory_unlock/)
  assert.equal(pool.released(), 1)
  // Exactly what is left fits.
  assert.equal((await importer({ pool: ledger({ remaining: BigInt(known.spentLamports) }) }).record(known.signature)).amount, known.spentLamports)
})

test('the same buyback is recorded once; an unknown allocation is refused', async () => {
  const known = custodyBuys[0]
  await assert.rejects(importer({ pool: ledger({ recorded: true }) }).record(known.signature), { message: BUYBACK_IMPORT_REFUSALS.recorded })
  await assert.rejects(importer({ pool: ledger({ group: null }) }).record(known.signature), { message: BUYBACK_IMPORT_REFUSALS.group })
  const named = ledger()
  await assert.rejects(importer({ pool: named }).record(known.signature, { allocationGroup: 'another-group' }), { message: BUYBACK_IMPORT_REFUSALS.group })
  assert.equal(named.released(), 1)
})
