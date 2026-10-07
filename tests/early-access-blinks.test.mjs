import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { handleBuyGet, handleBuyPost, handleSellPost } from '../app/lib/solana-actions.mjs'
import { prepareActionTrade, walletTokenBalance } from '../app/lib/action-trades.mjs'
import { EARLY_ACCESS_NOT_TRADABLE, earlyAccessEndUtc } from '../src/early-access.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK } from '../src/early-access-hook.mjs'
import { contributorsOnly } from '../src/early-access-trade.mjs'

// Step 5e (docs/EARLY_ACCESS.md): Blinks for contributor early access markets. Offered only where the site's trader takes them
// (EARLY_ACCESS_DBC_CONFIG), the window on the Blink card, sells read from the wallet's Token-2022 account, and the trader's
// refusals final (never retried without the referral). On chain: tests/early-access-launch-chain.test.mjs.
const MINT = Keypair.generate().publicKey.toBase58()
const wallet = Keypair.generate().publicKey
const END = Date.parse('2026-10-07T12:15:00Z')
const market = { repoId: '7', mint: MINT, symbol: 'EA', fullName: 'octo/early', description: 'Early.', quoteMint: null,
  earlyAccessEnd: new Date(END), transferHookProgram: HOOK.toBase58() }
const loadMarket = async mint => mint === MINT ? market : null
const post = (path, body = { account: wallet.toBase58() }) => new Request(`https://repo.ing${path}`, { method: 'POST', body: JSON.stringify(body) })

test('a trade message names the window\'s end in UTC', () => {
  assert.equal(earlyAccessEndUtc(END), '2026-10-07 12:15 UTC')
  assert.equal(contributorsOnly(END), 'Contributor early access: only this repository\'s linked contributors can buy until 2026-10-07 12:15 UTC.')
})

test('a Blink for an early access market only where the trader takes it; its card leads with the window', async () => {
  const off = await handleBuyGet(MINT, { loadMarket, earlyAccessTrades: () => false })
  assert.deepEqual([off.status, (await off.json()).message], [404, EARLY_ACCESS_NOT_TRADABLE])
  const saved = process.env.EARLY_ACCESS_DBC_CONFIG
  try {
    for (const value of [undefined, 'not-a-key']) {
      value === undefined ? delete process.env.EARLY_ACCESS_DBC_CONFIG : process.env.EARLY_ACCESS_DBC_CONFIG = value
      const answer = await handleBuyGet(MINT, { loadMarket })
      assert.deepEqual([answer.status, (await answer.json()).message], [404, EARLY_ACCESS_NOT_TRADABLE], `setting ${value}`)
    }
    process.env.EARLY_ACCESS_DBC_CONFIG = Keypair.generate().publicKey.toBase58()
    assert.equal((await handleBuyGet(MINT, { loadMarket })).status, 200, 'set: offered')
  } finally { saved === undefined ? delete process.env.EARLY_ACCESS_DBC_CONFIG : process.env.EARLY_ACCESS_DBC_CONFIG = saved }
  const realNow = Date.now
  try {
    Date.now = () => END - 60_000
    const card = await (await handleBuyGet(MINT, { loadMarket, earlyAccessTrades: () => true })).json()
    assert.match(card.description, /^Contributor early access until Oct 7, 12:15 UTC: only this repository's linked contributors can buy\. Anyone can sell\. Early\./)
    assert.ok(card.links.actions.some(action => /^Sell/.test(action.label)), 'sell buttons too')
    Date.now = () => END
    assert.match((await (await handleBuyGet(MINT, { loadMarket, earlyAccessTrades: () => true })).json()).description, /^Early\./, 'after the window')
  } finally { Date.now = realNow }
})

test('a Blink sell of an early access token reads the wallet\'s Token-2022 account; an SPL market\'s reads SPL Token', async () => {
  const reads = []
  const prepareSell = async request => ({ transaction: new Transaction({ feePayer: wallet, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wallet, lamports: 1 })), direction: 'sell', mint: MINT, amountIn: BigInt(request.amountBaseUnits),
    minimumAmountOut: 1n })
  const tokenBalance = async (owner, mint, options) => { reads.push(options); return 1000n }
  for (const [label, forMarket, token2022] of [['early access', market, true], ['SPL', { ...market, earlyAccessEnd: null, transferHookProgram: null }, false]]) {
    const response = await handleSellPost(post(`/api/actions/sell/${MINT}?percent=50`), MINT, { loadMarket: async () => forMarket, tokenBalance, prepareSell,
      earlyAccessTrades: () => true })
    assert.equal(response.status, 200, label)
    assert.deepEqual(reads.pop(), { token2022 }, label)
  }
  // The balance itself: the Token-2022 associated account, owned by Token-2022, for this wallet and mint.
  const account = (owner, amount = 42n, program = TOKEN_2022_PROGRAM_ID) => {
    const data = Buffer.alloc(165)
    AccountLayout.encode({ mint: new PublicKey(MINT), owner: wallet, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0,
      isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data)
    return { owner: program, data: Buffer.concat([data, Buffer.from([2])]), lamports: 1, executable: false }
  }
  const at = []
  const connection = info => ({ getAccountInfo: async address => { at.push(address.toBase58()); return info } })
  assert.equal(await walletTokenBalance(wallet, MINT, connection(account()), { token2022: true }), 42n)
  assert.equal(at.pop(), getAssociatedTokenAddressSync(new PublicKey(MINT), wallet, false, TOKEN_2022_PROGRAM_ID).toBase58())
  assert.equal(await walletTokenBalance(wallet, MINT, connection({ ...account(), owner: TOKEN_PROGRAM_ID }), { token2022: true }), 0n)
  assert.equal(await walletTokenBalance(wallet, MINT, connection(account()), {}), 0n, 'an SPL read of a Token-2022 account holds nothing')
  assert.equal(at.pop(), getAssociatedTokenAddressSync(new PublicKey(MINT), wallet).toBase58())
})

test('a Blink buy refused by early access is final: never retried without the referral', async () => {
  const requests = []
  const engine = { prepareBuy: async request => { requests.push(request); throw Error(contributorsOnly(END)) } }
  await assert.rejects(prepareActionTrade('buy', { githubRepoId: '7', wallet: wallet.toBase58(), amountLamports: '1000', referrer: Keypair.generate().publicKey.toBase58() },
    { router: async () => engine, connection: {} }), { message: contributorsOnly(END) })
  assert.equal(requests.length, 1)
  // An early access Blink passes its referral to the trader like a SOL market's: the curve trader leaves it out, the graduated
  // trader pays it in SOL (step 7b).
  const asked = []
  const prepareBuy = async request => { asked.push(request); return { transaction: new Transaction({ feePayer: wallet, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wallet, lamports: 1 })), direction: 'buy', mint: MINT, amountIn: 100_000_000n, minimumAmountOut: 1n } }
  const ref = Keypair.generate().publicKey.toBase58()
  for (const forMarket of [market, { ...market, earlyAccessEnd: null, transferHookProgram: null }]) {
    const answer = await handleBuyPost(post(`/api/actions/buy/${MINT}?amount=0.1&ref=${ref}`), MINT, { loadMarket: async () => forMarket, prepareBuy, earlyAccessTrades: () => true })
    assert.equal(answer.status, 200)
  }
  assert.deepEqual(asked.map(request => request.referrer ?? null), [ref, ref])
  // The Blink shows the refusal (an app-authored message).
  const response = await handleBuyPost(post(`/api/actions/buy/${MINT}?amount=0.1`), MINT, { loadMarket, earlyAccessTrades: () => true,
    prepareBuy: async () => { throw Error(contributorsOnly(END)) } })
  assert.deepEqual([response.status, (await response.json()).message], [400, contributorsOnly(END)])
})
