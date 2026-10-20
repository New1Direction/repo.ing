// A coin on our own stack through the chart, trades and holders APIs: the trade index decodes its native swaps as
// lamports trades, every read names the coin's own programs and pool (never a legacy address), and no response ever
// carries the stack's internal quote marker. Real handlers and indexer over an in-memory store and recorded reads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { createCoinActivityHandlers, createOnDemandIndexer } from '../app/lib/hooklab-coin-activity.mjs'
import { HOLDING } from '../src/hooklab-coin-activity.mjs'
import { binding } from '../src/hooklab-owner-driver/artifacts.mjs'
import { holdingAddress } from '../src/hooklab-owner-driver/pins.mjs'
import { LEGACY_STACK } from '../src/hooklab-stack.mjs'
import { ownAddresses, ownLaunch, ownMint, ownProfile, ownSwap, ownTrader, signatureOf } from './fixtures/hooklab-own-stack-trades.mjs'

const MARKER = ownProfile.quoteMint, TOKEN = ownProfile.programs.token
const LEGACY = new Set([...Object.values(LEGACY_STACK.programs), LEGACY_STACK.quoteMint])
const history = [{ signature: signatureOf(2), slot: 101, err: null }, { signature: signatureOf(1), slot: 100, err: null }, { signature: signatureOf(3), slot: 99, err: null }]
const transactions = { [signatureOf(3)]: ownLaunch({ n: 3, slot: 99 }), [signatureOf(1)]: ownSwap({ n: 1, slot: 100 }),
  [signatureOf(2)]: ownSwap({ n: 2, slot: 101, side: 'sell', amountIn: 2000000000000n, out: 900000000n, swapCount: 2 }) }

// A holding row as getProgramAccounts returns it (the first 82 bytes), under our own token program.
function holdingRow(owner, amount) {
  const data = Buffer.alloc(HOLDING.read)
  Buffer.from(binding('token').idl.accounts.find(a => a.name === 'Holding').discriminator).copy(data, 0); data[8] = 1
  new PublicKey(ownMint).toBuffer().copy(data, HOLDING.mint); new PublicKey(owner).toBuffer().copy(data, HOLDING.owner); data.writeBigUInt64LE(BigInt(amount), HOLDING.amount)
  return { pubkey: new PublicKey(holdingAddress(ownMint, owner, TOKEN)), account: { owner: new PublicKey(TOKEN), data } }
}
// The coin's reads, bound to its stack as the runtime's activityFor(coin) is: every address asked for is recorded.
function ownRpc(asked) {
  return {
    async signatures(pool, { before, until, limit }) {
      asked.push(pool)
      let list = history
      if (before) list = list.slice(list.findIndex(i => i.signature === before) + 1)
      if (until) { const at = list.findIndex(i => i.signature === until); if (at >= 0) list = list.slice(0, at) }
      return list.slice(0, limit)
    },
    async transaction(signature) { asked.push(signature); return transactions[signature] ?? null },
    async holdings(mint, { token }) {
      asked.push(mint, token)
      return { context: { slot: 102 }, value: [holdingRow(ownAddresses.pool, '700000000000000'), holdingRow(ownAddresses.launch, '250000000000000'),
        holdingRow(ownTrader, '40000000000000'), holdingRow(MARKER, '10000000000000')] }
    },
  }
}
// The index's tables in memory, with the store's contract (src/hooklab-coin-trades.mjs hookCoinTradeStore).
function memoryStore() {
  const rows = [], cursors = new Map(), n = row => BigInt(row.swapCount)
  return { rows, store: {
    async cursor(pool) { return cursors.get(pool) ?? null },
    async progress(pool) { return { swapCount: rows.filter(r => r.pool === pool).reduce((max, r) => n(r) > max ? n(r) : max, 0n), walking: !!cursors.get(pool)?.walk } },
    async record({ pool, mint, to, trades }) {
      cursors.set(pool, { mint, done: to.done, walk: to.walk })
      const fresh = trades.filter(t => !rows.some(r => r.signature === t.signature && r.eventIndex === t.eventIndex)); rows.push(...fresh); return fresh.length
    },
    async trades(pool, { limit }) {
      const list = rows.filter(r => r.pool === pool).sort((a, b) => Number(n(b) - n(a)))
      return { trades: list.slice(0, limit).map(({ signature, eventIndex, side, trader, tradedAt, slot, swapCount, quoteAmount, baseAmount, curveBase, curveQuote }) =>
        ({ signature, eventIndex, side, trader, tradedAt, slot: String(slot), swapCount, quoteAmount, baseAmount, curveBase, curveQuote })), next: null }
    },
    async summary(pool) {
      const list = rows.filter(r => r.pool === pool).sort((a, b) => Number(n(a) - n(b))), last = list.at(-1)
      return { totalTrades: list.length, volume24hLamports: String(list.reduce((s, r) => s + BigInt(r.quoteAmount), 0n)), firstTradeAt: list[0]?.tradedAt ?? null,
        lastTradeAt: last?.tradedAt ?? null, latest: last ? { tradedAt: last.tradedAt, priceSol: Number(last.curveQuote) / Number(last.curveBase) * 1e-3 } : null }
    },
    async candles(pool) { return rows.filter(r => r.pool === pool).map(r => ({ time: 1800000000, open: 1, high: 1, low: 1, close: 1, volumeLamports: r.quoteAmount, count: 1 })) },
  } }
}

test('a coin on our own stack: lamports trades, its own reads only, and never its quote marker', async () => {
  const asked = [], db = memoryStore(), openStore = () => ({ store: db.store, close: async () => {} }), coin = { id: 'own', stack: 'own' }
  const market = { mint: ownMint, name: 'Own', symbol: 'OWN', decimals: 6, graduated: false, initialSupply: '1000000000000000', supply: '1000000000000000', pool: { swapCount: '2' } }
  const service = { market: async (mint, wallet, listed) => { assert.equal(listed, coin, 'the market read is told which coin (and so which stack)'); return { market, wallet: null } },
    coinProfile: async () => coin, profileFor: c => c.stack === 'own' ? ownProfile : null, activityFor: c => c.stack === 'own' ? ownRpc(asked) : null }
  const handlers = createCoinActivityHandlers({ runtime: () => service, listed: async () => coin, openStore, solUsd: () => null,
    indexer: createOnDemandIndexer({ openStore, minMs: 0, waitMs: 5_000 }) })
  const get = async path => {
    const response = await handlers[path](new Request(`https://repo.ing/api/hook-lab/market/${ownMint}/${path}`), { mint: ownMint })
    assert.equal(response.status, 200, path); return response.text()
  }
  const texts = { trades: await get('trades'), candles: await get('candles'), holders: await get('holders') }
  // The index: the open launch is no trade; each native swap is one lamports trade under its SwappedNative.
  assert.deepEqual(db.rows.map(r => [r.event, r.quoteAsset, r.side, r.quoteAmount]), [['SwappedNative', 'lamports', 'sell', '890000000'], ['SwappedNative', 'lamports', 'buy', '1000000000']])
  assert.deepEqual(JSON.parse(texts.trades).trades.map(t => [t.side, t.solLamports]), [['sell', '890000000'], ['buy', '1000000000']])
  assert.equal(JSON.parse(texts.candles).totalTrades, 2)
  const holders = JSON.parse(texts.holders)
  assert.deepEqual(holders.holders.map(h => [h.label ?? h.owner, h.percent]), [['Bonding curve', 70], ['Launch reserve', 25], [ownTrader, 4]])
  assert.equal(holders.holderCount, 1, 'a holding opened for the marker is never listed or ranked')
  // Every read named the coin's own pool, transactions and token program; nothing legacy was ever asked for.
  assert.ok(asked.includes(ownAddresses.pool) && asked.includes(ownProfile.programs.token))
  assert.deepEqual(asked.filter(a => LEGACY.has(a)), [])
  // No response carries the internal quote marker, its name, or "quote token" wording.
  for (const [path, text] of Object.entries(texts)) {
    assert.ok(!text.includes(MARKER), `${path} names the marker`)
    assert.ok(!/quote[ -]?(token|mint|marker)/i.test(text), `${path} speaks of a quote token`)
  }
})

test('a coin whose stack the runtime cannot serve is unavailable, never read under another stack', async () => {
  const asked = [], coin = { id: 'own', stack: 'own' }
  const service = { market: async () => { asked.push('market'); return null }, coinProfile: async () => coin, profileFor: () => null, activityFor: () => null }
  const handlers = createCoinActivityHandlers({ runtime: () => service, listed: async () => coin, openStore: () => { throw Error('no database needed') } })
  for (const path of ['trades', 'candles', 'holders']) {
    assert.equal((await handlers[path](new Request(`https://repo.ing/api/hook-lab/market/${ownMint}/${path}`), { mint: ownMint })).status, 503)
  }
  assert.deepEqual(asked, [], 'no market read either')
})
