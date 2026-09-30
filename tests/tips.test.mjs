import test from 'node:test'
import assert from 'node:assert/strict'
import { sign } from 'node:crypto'
import bs58 from 'bs58'
import pg from 'pg'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ExtensionType, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { TIP_MIN_USD, TIP_TOKENS, assertTipAmount, minimumTipBaseUnits, parseTipAmount, readJupiterPrices, tipMintCheck, tipToken } from '../src/tip-tokens.mjs'
import { MEMO_PROGRAM, REFUND_AFTER_MS, acceptSignedTip, prepareTip, readTipWallet, refreshTip, loadTip, submitTip, tipInstructions, tipMemo, verifyTipReceipt, createTipExpiry } from '../src/tips.mjs'
import { TIP_OPERATING_RESERVE_LAMPORTS, createTipPayouts, createTipRefunds, createTipTransferRecovery, tipWalletCoverage, transferInstructions, verifyTransferReceipt } from '../src/tip-transfers.mjs'
import { refundChallenge, verifyRefundRequest } from '../src/tip-refund-auth.mjs'
import { LIGHTHOUSE_PROGRAM } from '../src/launch-wallet-assertions.mjs'
import { feeExt, fakeChain, hookExt, mintData, pausedExt, defaultStateExt, splMint, xstockMint } from './fixtures/tip-chain.mjs'

const SOL = tipToken(NATIVE_MINT.toBase58())
const USDC = tipToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const NVDAX = tipToken('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh')
const PRICES = { [SOL.mint]: 100, [USDC.mint]: 1, [NVDAX.mint]: 200 }
const silent = () => {}
const LANDING = { intervalMs: 0, maxMs: 1, sleep: async () => {} }

// ---------- Allowlist, minimums, prices ----------
test('allowlist pins SOL, USDC and nine Backed xStocks with their programs and decimals', () => {
  assert.equal(TIP_TOKENS.length, 11)
  assert.equal(new Set(TIP_TOKENS.map(t => t.mint)).size, 11)
  assert.deepEqual(TIP_TOKENS.filter(t => t.kind === 'xstock').map(t => t.symbol), ['SPYx', 'QQQx', 'NVDAx', 'TSLAx', 'AAPLx', 'MSFTx', 'GOOGLx', 'AMZNx', 'METAx'])
  for (const t of TIP_TOKENS.filter(t => t.kind === 'xstock')) {
    assert.equal(t.program, TOKEN_2022_PROGRAM_ID.toBase58()); assert.equal(t.decimals, 8); assert.match(t.mint, /^Xs/)
  }
  assert.equal(USDC.program, TOKEN_PROGRAM_ID.toBase58()); assert.equal(USDC.decimals, 6)
  assert.equal(SOL.program, SystemProgram.programId.toBase58()); assert.equal(SOL.decimals, 9)
  assert.throws(() => tipToken(Keypair.generate().publicKey.toBase58()), /not accepted/)
  assert.ok(Object.isFrozen(TIP_TOKENS) && Object.isFrozen(TIP_TOKENS[0]))
})

test('per-token minimum is about $5 at the current price and tips refuse when no price is available', () => {
  assert.equal(TIP_MIN_USD, 5)
  assert.equal(minimumTipBaseUnits(SOL, 100), 50_000_000n)
  assert.equal(minimumTipBaseUnits(USDC, 1), 5_000_000n)
  assert.equal(minimumTipBaseUnits(NVDAX, 200), 2_500_000n)
  assert.equal(minimumTipBaseUnits(USDC, 0.99988), 5_000_601n)
  for (const bad of [undefined, null, 0, -1, NaN, Infinity]) assert.throws(() => minimumTipBaseUnits(SOL, bad), /price is unavailable/)
  assert.throws(() => assertTipAmount(SOL, 49_999_999n, 100), /Tips start at \$5/)
  assert.equal(assertTipAmount(SOL, 50_000_000n, 100), 50_000_000n)
  for (const bad of ['0', '-1', '1.5', '01', '', 5, '18446744073709551616', '1'.repeat(21)]) assert.throws(() => parseTipAmount(bad), /Invalid tip amount/)
  assert.equal(parseTipAmount('18446744073709551615'), 2n ** 64n - 1n)
})

test('Jupiter prices use the prescaled price for scaled-UI xStocks and drop invalid rows', () => {
  const prices = readJupiterPrices({ [SOL.mint]: { usdPrice: 118.4 }, [NVDAX.mint]: { usdPrice: 228.07, scaledUiConfig: { usdPricePrescaled: 228.45 } },
    [USDC.mint]: { usdPrice: 'x' } })
  assert.deepEqual(prices, { [SOL.mint]: 118.4, [NVDAX.mint]: 228.45 })
})

test('live mint check accepts xStocks with a null hook and rejects active hooks, fees, pauses, frozen defaults and drift', () => {
  const nvdax = { mint: NVDAX.mint, program: NVDAX.program, decimals: 8 }
  assert.equal(tipMintCheck(nvdax, xstockMint(), 900).ok, true)
  assert.equal(tipMintCheck(USDC, splMint(), 900).ok, true)
  assert.equal(tipMintCheck(SOL, null, 900).ok, true)
  assert.throws(() => tipMintCheck(nvdax, xstockMint([hookExt(Keypair.generate().publicKey)]), 900), /active transfer hook/)
  assert.throws(() => tipMintCheck(nvdax, xstockMint([feeExt(25)]), 900), /active transfer fee/)
  assert.throws(() => tipMintCheck(nvdax, xstockMint([feeExt(0, 1n)]), 900), /active transfer fee/)
  assert.equal(tipMintCheck(nvdax, xstockMint([feeExt(0, 0n)]), 900).ok, true)
  assert.throws(() => tipMintCheck(nvdax, xstockMint([pausedExt(true)]), 900), /paused/)
  assert.throws(() => tipMintCheck(nvdax, xstockMint([defaultStateExt(2)]), 900), /start frozen/)
  assert.throws(() => tipMintCheck(nvdax, xstockMint([[ExtensionType.NonTransferable, Buffer.alloc(0)]]), 900), /non-transferable/)
  assert.throws(() => tipMintCheck(nvdax, { ...xstockMint(), owner: TOKEN_PROGRAM_ID }, 900), /different token program/)
  assert.throws(() => tipMintCheck(USDC, { ...splMint(), data: mintData({ decimals: 9 }) }, 900), /decimals changed/)
  assert.throws(() => tipMintCheck(USDC, null, 900), /unavailable/)
})

// ---------- Configuration ----------
test('tip wallet comes only from TIP_WALLET_SECRET_KEY; absent disables, bad or mismatched config never echoes the key', () => {
  const key = Keypair.generate(), secret = bs58.encode(key.secretKey)
  assert.equal(readTipWallet({}), null)
  assert.equal(readTipWallet({ TIP_WALLET_SECRET_KEY: '  ' }), null)
  assert.ok(readTipWallet({ TIP_WALLET_SECRET_KEY: secret }).publicKey.equals(key.publicKey))
  assert.ok(readTipWallet({ TIP_WALLET_SECRET_KEY: JSON.stringify([...key.secretKey]), TIP_WALLET_ADDRESS: key.publicKey.toBase58() }).publicKey.equals(key.publicKey))
  assert.throws(() => readTipWallet({ TIP_WALLET_SECRET_KEY: secret, TIP_WALLET_ADDRESS: Keypair.generate().publicKey.toBase58() }), error => /does not match/.test(error.message) && !error.message.includes(secret))
  assert.throws(() => readTipWallet({ TIP_WALLET_SECRET_KEY: 'not-a-key' }), error => /not a valid/.test(error.message) && !error.message.includes('not-a-key'))
})

test('tips API is disabled without TIP_WALLET_SECRET_KEY', async () => {
  const saved = process.env.TIP_WALLET_SECRET_KEY
  delete process.env.TIP_WALLET_SECRET_KEY
  try {
    const { POST } = await import('../app/api/tips/route.js')
    for (const action of ['options', 'prepare', 'submit']) {
      const response = await POST(new Request('http://localhost/api/tips', { method: 'POST', body: JSON.stringify({ action, githubRepoId: '1' }) }))
      assert.equal(response.status, 503)
      assert.equal((await response.json()).error, 'Tips are not enabled')
    }
    const { tipsEnabled } = await import('../app/lib/tips.mjs')
    assert.equal(tipsEnabled(), false)
  } finally { if (saved !== undefined) process.env.TIP_WALLET_SECRET_KEY = saved }
})

// ---------- Prepare: exact instructions ----------
const program = ix => ix.programId.toBase58()
test('SOL tip is a system transfer to the tip wallet plus the tip memo', () => {
  const donor = Keypair.generate().publicKey, tipWallet = Keypair.generate().publicKey, id = crypto.randomUUID()
  const [transfer, memo, ...rest] = tipInstructions({ token: SOL, donor, tipWallet, amount: 60_000_000n, id })
  assert.equal(rest.length, 0)
  const decoded = SystemInstruction.decodeTransfer(transfer)
  assert.ok(decoded.fromPubkey.equals(donor) && decoded.toPubkey.equals(tipWallet)); assert.equal(BigInt(decoded.lamports), 60_000_000n)
  assert.ok(memo.programId.equals(MEMO_PROGRAM)); assert.equal(memo.keys.length, 0); assert.equal(memo.data.toString(), `repoing-tip:${id}`)
})

for (const [label, token, tokenProgram] of [['USDC (SPL Token)', USDC, TOKEN_PROGRAM_ID], ['NVDAx (Token-2022 xStock)', NVDAX, TOKEN_2022_PROGRAM_ID]]) {
  test(`${label} tip creates the tip wallet ATA idempotently, then transfer_checked, then the memo`, () => {
    const donor = Keypair.generate().publicKey, tipWallet = Keypair.generate().publicKey, id = crypto.randomUUID(), mint = new PublicKey(token.mint)
    const ixs = tipInstructions({ token, donor, tipWallet, amount: 7_000_000n, id })
    assert.deepEqual(ixs.map(program), [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), tokenProgram.toBase58(), MEMO_PROGRAM.toBase58()])
    const destination = getAssociatedTokenAddressSync(mint, tipWallet, false, tokenProgram)
    const source = getAssociatedTokenAddressSync(mint, donor, false, tokenProgram)
    assert.deepEqual([...ixs[0].data], [1])
    assert.deepEqual(ixs[0].keys.map(k => k.pubkey.toBase58()), [donor, destination, tipWallet, mint, SystemProgram.programId, tokenProgram].map(k => k.toBase58()))
    assert.equal(ixs[1].data[0], 12); assert.equal(ixs[1].data.readBigUInt64LE(1), 7_000_000n); assert.equal(ixs[1].data[9], token.decimals)
    assert.deepEqual(ixs[1].keys.map(k => k.pubkey.toBase58()), [source, mint, destination, donor].map(k => k.toBase58()))
    assert.ok(ixs[1].keys[3].isSigner && !ixs[1].keys[2].isSigner)
    assert.equal(ixs[2].data.toString(), tipMemo(id))
  })
}

function fakePool(markets = ['42']) {
  const inserted = []
  return { inserted, async query(sql, params) {
    if (/from markets/.test(sql)) return { rows: markets.includes(params[0]) ? [{ repoId: params[0] }] : [] }
    if (/insert into repo_tips/.test(sql)) { inserted.push(params); return { rows: [], rowCount: 1 } }
    throw Error(`unexpected query ${sql}`)
  } }
}

test('prepare builds an unsigned, priority-fee transaction for a real-shaped donor and persists the pending tip', async () => {
  const donor = Keypair.generate(), tipWallet = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [donor.publicKey.toBase58()]: 1_000_000_000 }, mints: { [NVDAX.mint]: xstockMint() } })
  const donorAta = getAssociatedTokenAddressSync(new PublicKey(NVDAX.mint), donor.publicKey, false, TOKEN_2022_PROGRAM_ID)
  connection.tokenAccount(donorAta.toBase58(), NVDAX.mint, donor.publicKey.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), 10_000_000n)
  const pool = fakePool(), now = Date.parse('2026-09-29T00:00:00Z')
  const prepared = await prepareTip({ pool, connection, tipWallet, prices: PRICES, githubRepoId: '42', wallet: donor.publicKey.toBase58(),
    mint: NVDAX.mint, amountBaseUnits: '3000000', now: () => now, log: silent })
  const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
  assert.ok(tx.feePayer.equals(donor.publicKey)); assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].signature, null)
  assert.deepEqual(tx.instructions.map(program), [ComputeBudgetProgram.programId, ComputeBudgetProgram.programId, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MEMO_PROGRAM].map(k => k.toBase58()))
  assert.equal(tx.instructions[4].data.toString(), tipMemo(prepared.id))
  const [row] = pool.inserted
  assert.deepEqual(row.slice(0, 9), [prepared.id, '42', donor.publicKey.toBase58(), tipWallet.toBase58(), NVDAX.mint, NVDAX.program, 8, 'NVDAx', '3000000'])
  assert.equal(row[9], Buffer.from(tx.serializeMessage()).toString('base64'))
  assert.equal(row[12].getTime(), now); assert.equal(row[13].getTime() - row[12].getTime(), REFUND_AFTER_MS)
  // Below the minimum, unknown repo, non-allowlisted mint, missing price and the tip wallet itself are refused before any insert.
  const args = { pool, connection, tipWallet, prices: PRICES, githubRepoId: '42', wallet: donor.publicKey.toBase58(), mint: NVDAX.mint, log: silent }
  await assert.rejects(prepareTip({ ...args, amountBaseUnits: '2499999' }), /Tips start at/)
  await assert.rejects(prepareTip({ ...args, githubRepoId: '7', amountBaseUnits: '3000000' }), /no market/)
  await assert.rejects(prepareTip({ ...args, mint: Keypair.generate().publicKey.toBase58(), amountBaseUnits: '3000000' }), /not accepted/)
  await assert.rejects(prepareTip({ ...args, prices: {}, amountBaseUnits: '3000000' }), /price is unavailable/)
  await assert.rejects(prepareTip({ ...args, wallet: tipWallet.toBase58(), amountBaseUnits: '3000000' }), /cannot tip itself/)
  await assert.rejects(prepareTip({ ...args, tipWallet: null, amountBaseUnits: '3000000' }), /Tips are not enabled/)
  await assert.rejects(prepareTip({ ...args, amountBaseUnits: '30000000' }), /does not hold enough NVDAx/)
  connection.state.mints.set(NVDAX.mint, xstockMint([hookExt(Keypair.generate().publicKey)]))
  await assert.rejects(prepareTip({ ...args, amountBaseUnits: '3000000' }), /active transfer hook/)
  assert.equal(pool.inserted.length, 1)
})

// ---------- Submit: signed transaction acceptance ----------
async function preparedTip(token = USDC, amount = '6000000', overrides = {}) {
  const donor = Keypair.generate(), tipWallet = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [donor.publicKey.toBase58()]: 1_000_000_000 }, mints: { [USDC.mint]: splMint(), [NVDAX.mint]: xstockMint() } })
  if (token !== SOL) connection.tokenAccount(getAssociatedTokenAddressSync(new PublicKey(token.mint), donor.publicKey, false, new PublicKey(token.program)).toBase58(),
    token.mint, donor.publicKey.toBase58(), token.program, 100_000_000n)
  const pool = fakePool()
  const prepared = await prepareTip({ pool, connection, tipWallet, prices: PRICES, githubRepoId: '42', wallet: donor.publicKey.toBase58(),
    mint: token.mint, amountBaseUnits: amount, log: silent, ...overrides })
  const p = pool.inserted[0]
  const tip = { id: p[0], githubRepoId: p[1], donorWallet: p[2], tipWallet: p[3], mint: p[4], tokenProgram: p[5], decimals: p[6], symbol: p[7],
    requestedAmount: p[8], message: p[9], transaction: p[10], lastValidBlockHeight: String(p[11]), status: 'prepared', signature: null }
  return { donor, tipWallet, connection, prepared, tip, unsigned: Transaction.from(Buffer.from(prepared.transaction, 'base64')) }
}
const signedBase64 = (tx, signer) => { tx.sign(signer); return tx.serialize().toString('base64') }
const rebuilt = (unsigned, instructions) => new Transaction({ feePayer: unsigned.feePayer, recentBlockhash: unsigned.recentBlockhash }).add(...instructions)

test('submit accepts the exact reviewed tip and rejects altered amount, destination, missing memo, other payer and unsigned bytes', async () => {
  const { donor, tip, unsigned } = await preparedTip()
  const accepted = acceptSignedTip(tip, signedBase64(Transaction.from(unsigned.serialize({ requireAllSignatures: false })), donor))
  assert.equal(accepted.signature, bs58.encode(accepted.signed.signature))
  const [limit, price, ata, transfer, memo] = unsigned.instructions
  const changedAmount = new TransactionInstruction({ ...transfer, data: Buffer.from(transfer.data) }); changedAmount.data.writeBigUInt64LE(1n, 1)
  const otherWallet = Keypair.generate().publicKey
  const otherDestination = getAssociatedTokenAddressSync(new PublicKey(USDC.mint), otherWallet)
  const redirected = new TransactionInstruction({ programId: transfer.programId, data: transfer.data,
    keys: transfer.keys.map((k, i) => i === 2 ? { ...k, pubkey: otherDestination } : k) })
  const wrongMemo = new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(tipMemo(crypto.randomUUID())) })
  for (const instructions of [[limit, price, ata, changedAmount, memo], [limit, price, ata, redirected, memo], [limit, price, ata, transfer],
    [limit, price, ata, transfer, wrongMemo], [limit, ata, transfer, memo]]) {
    assert.throws(() => acceptSignedTip(tip, signedBase64(rebuilt(unsigned, instructions), donor)), /altered or unsigned/)
  }
  const stranger = Keypair.generate()
  const strangerPays = new Transaction({ feePayer: stranger.publicKey, recentBlockhash: unsigned.recentBlockhash }).add(...unsigned.instructions)
  strangerPays.sign(stranger, donor)
  assert.throws(() => acceptSignedTip(tip, strangerPays.serialize().toString('base64')), /altered or unsigned/)
  assert.throws(() => acceptSignedTip(tip, unsigned.serialize({ requireAllSignatures: false }).toString('base64')), /altered or unsigned/)
  assert.throws(() => acceptSignedTip(tip, 'not base64 transaction'), /altered or unsigned/)
  assert.throws(() => acceptSignedTip({ ...tip, signature: bs58.encode(Buffer.alloc(64, 1)) }, signedBase64(Transaction.from(unsigned.serialize({ requireAllSignatures: false })), donor)), /different signed transaction/)
})

test('submit accepts a wallet-appended Lighthouse assertion but not a writable or foreign-program addition', async () => {
  const { donor, tip, unsigned } = await preparedTip()
  const lighthouse = (data, writable = false) => new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM), data,
    keys: [{ pubkey: donor.publicKey, isSigner: false, isWritable: writable }] })
  const withAssertion = rebuilt(unsigned, [...unsigned.instructions, lighthouse(Buffer.from([2, 0, 0, 0]))])
  assert.ok(acceptSignedTip(tip, signedBase64(withAssertion, donor)).signature)
  assert.throws(() => acceptSignedTip(tip, signedBase64(rebuilt(unsigned, [...unsigned.instructions, lighthouse(Buffer.from([0, 0, 0, 0]))]), donor)), /altered/)
  const extra = new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from('x') })
  assert.throws(() => acceptSignedTip(tip, signedBase64(rebuilt(unsigned, [...unsigned.instructions, extra]), donor)), /altered/)
})

// ---------- Receipt verification ----------
function landed(connection, raw) { return connection.sendRawTransaction(raw).then(signature => connection.receipts.get(signature)) }
for (const [label, token, amount] of [['SOL', SOL, '60000000'], ['USDC', USDC, '6000000'], ['transfer-fee-free Token-2022 NVDAx', NVDAX, '3000000']]) {
  test(`receipt verification records the exact ${label} amount received by the tip wallet`, async () => {
    const { donor, tip, unsigned, connection } = await preparedTip(token, amount)
    const signed = Transaction.from(Buffer.from(signedBase64(Transaction.from(unsigned.serialize({ requireAllSignatures: false })), donor), 'base64'))
    const receipt = await landed(connection, signed.serialize())
    const submitted = { ...tip, signature: bs58.encode(signed.signature), signedTransaction: signed.serialize().toString('base64') }
    assert.equal(verifyTipReceipt(receipt, submitted).received, BigInt(amount))
    assert.throws(() => verifyTipReceipt(receipt, { ...submitted, requestedAmount: String(BigInt(amount) + 1n) }), /different amount/)
    assert.throws(() => verifyTipReceipt(receipt, { ...submitted, id: crypto.randomUUID() }), /memo is missing/)
    assert.throws(() => verifyTipReceipt(receipt, { ...submitted, tipWallet: Keypair.generate().publicKey.toBase58() }), /missing from the receipt/)
    assert.throws(() => verifyTipReceipt({ ...receipt, meta: { ...receipt.meta, err: { x: 1 } } }, submitted), /failed/)
    if (token !== SOL) {
      // A fee-charging mint would deliver less than requested: never recorded.
      const short = structuredClone(receipt.meta.postTokenBalances)
      const index = short.findIndex(b => b.owner === tip.tipWallet); short[index].uiTokenAmount.amount = String(BigInt(amount) - 1n)
      assert.throws(() => verifyTipReceipt({ ...receipt, meta: { ...receipt.meta, postTokenBalances: short } }, submitted), /different amount/)
    }
  })
}

test('refund proof: only the donor wallet signature over the exact challenge is accepted, and it expires', () => {
  const donor = Keypair.generate(), ids = [crypto.randomUUID()], now = Date.now()
  const { terms, message } = refundChallenge({ wallet: donor.publicKey.toBase58(), tipIds: ids, now: () => now })
  const signature = Buffer.from(nacl(message, donor)).toString('base64')
  assert.deepEqual(verifyRefundRequest(terms, signature, () => now), { donorWallet: donor.publicKey.toBase58(), tipIds: ids })
  assert.throws(() => verifyRefundRequest({ ...terms, wallet: Keypair.generate().publicKey.toBase58() }, signature, () => now), /Invalid Solana wallet signature/)
  assert.throws(() => verifyRefundRequest({ ...terms, tipIds: [crypto.randomUUID()] }, signature, () => now), /Invalid Solana wallet signature/)
  assert.throws(() => verifyRefundRequest(terms, signature, () => terms.expiresAt + 1), /expired/)
  assert.throws(() => refundChallenge({ wallet: donor.publicKey.toBase58(), tipIds: ['nope'] }), /Choose up to 20/)
})
function nacl(message, keypair) {
  // Ed25519 signature with the Solana secret key via node:crypto (PKCS8 wrapper around the 32-byte seed).
  const seed = keypair.secretKey.subarray(0, 32)
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
  return sign(null, Buffer.from(message), { key: pkcs8, format: 'der', type: 'pkcs8' })
}

test('payout instructions: SOL transfer, or recipient ATA + transfer_checked with the stored token program, plus memo', () => {
  const source = Keypair.generate().publicKey, recipient = Keypair.generate().publicKey, id = crypto.randomUUID()
  const sol = transferInstructions({ kind: 'payout', id, source, recipient, mint: SOL.mint, tokenProgram: SOL.program, decimals: 9, amount: 5n })
  assert.deepEqual(sol.map(program), [SystemProgram.programId.toBase58(), MEMO_PROGRAM.toBase58()])
  const x = transferInstructions({ kind: 'refund', id, source, recipient, mint: NVDAX.mint, tokenProgram: NVDAX.program, decimals: 8, amount: 5n })
  assert.deepEqual(x.map(program), [ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MEMO_PROGRAM].map(k => k.toBase58()))
  assert.ok(x[0].keys[0].pubkey.equals(source)); assert.equal(x[1].data[9], 8); assert.equal(x[2].data.toString(), `repoing-tip-refund:${id}`)
})

// ---------- Real PostgreSQL: ledger, payouts, refunds, recovery ----------
const dbUrl = process.env.TIP_TEST_DATABASE_URL
const dbTest = (name, fn) => test(name, { skip: !dbUrl }, fn)
let pool
async function db() {
  if (pool) return pool
  const url = new URL(dbUrl)
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Disposable local test database required')
  pool = new pg.Pool({ connectionString: url.toString() })
  return pool
}
test.after(async () => { await pool?.end() })
async function resetDb() {
  const p = await db()
  for (const sql of ['delete from repo_tips', 'delete from tip_transfers', 'delete from repo_beneficiaries where github_repo_id in (4201,4202)',
    "delete from graduation_alerts where kind='TIP_WALLET_SHORTFALL'"]) await p.query(sql)
  for (const id of [4201, 4202]) await p.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at)
    values($1,'fixture',$2,$3,0,0,false,now()) on conflict do nothing`, [id, `tips-${id}`, `fixture/tips-${id}`])
  return p
}
// Inserts a tip that already landed on the fake chain (tokens now held by the tip wallet) and is confirmed.
async function confirmedTip(p, connection, { repo = 4201, token = USDC, amount, tipWallet, donor = Keypair.generate().publicKey, refundAfter = new Date(Date.now() + REFUND_AFTER_MS) }) {
  const id = crypto.randomUUID()
  await p.query(`insert into repo_tips(id, github_repo_id, donor_wallet, tip_wallet, mint, token_program, decimals, symbol, requested_amount, received_amount,
      status, message, transaction, last_valid_block_height, signature, signed_transaction, confirmed_at, refund_after)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'confirmed','m','t',1,$10,'s',now(),$11)`,
  [id, repo, donor.toBase58(), tipWallet.toBase58(), token.mint, token.program, token.decimals, token.symbol, String(amount), bs58.encode(Buffer.from(crypto.getRandomValues(new Uint8Array(64)))), refundAfter])
  if (token === SOL) connection.state.lamports.set(tipWallet.toBase58(), (connection.state.lamports.get(tipWallet.toBase58()) ?? 0n) + BigInt(amount))
  else {
    const ata = getAssociatedTokenAddressSync(new PublicKey(token.mint), tipWallet, false, new PublicKey(token.program)).toBase58()
    const held = connection.state.tokens.get(ata)?.amount ?? 0n
    connection.tokenAccount(ata, token.mint, tipWallet.toBase58(), token.program, held + BigInt(amount))
  }
  return id
}
const admin = repoId => async () => ({ verified: true, permission: 'admin', githubRepoId: String(repoId), githubUserId: '77', verifiedAt: new Date().toISOString() })
async function bindPayout(p, repo, wallet) {
  const { rows: [row] } = await p.query(`insert into repo_beneficiaries(github_repo_id, github_user_id, wallet) values($1,77,$2) returning bound_at`, [repo, wallet.toBase58()])
  return { repoId: String(repo), wallet: wallet.toBase58(), boundAt: new Date(row.bound_at).toISOString() }
}
const OPERATING = TIP_OPERATING_RESERVE_LAMPORTS + 50_000_000n

dbTest('submit → confirmed from the finalized receipt; unsigned tips expire after their blockhash; worker resolves abandoned tips', async () => {
  const p = await resetDb()
  const donor = Keypair.generate(), tipWallet = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [donor.publicKey.toBase58()]: 1_000_000_000 }, mints: { [USDC.mint]: splMint() } })
  connection.tokenAccount(getAssociatedTokenAddressSync(new PublicKey(USDC.mint), donor.publicKey).toBase58(), USDC.mint, donor.publicKey.toBase58(), USDC.program, 50_000_000n)
  await p.query(`insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,indexed_at,launch_finality)
    values(4201,'confirmed',$1,$1,'Tips','TIPS',now(),'finalized') on conflict do nothing`, [donor.publicKey.toBase58()]).catch(() => null)
  const accepts = (await p.query('select 1 from markets where github_repo_id=4201')).rowCount
  const repoPool = accepts ? p : { query: (sql, params) => /from markets/.test(sql) ? { rows: [{ repoId: '4201' }] } : p.query(sql, params) }
  const prepared = await prepareTip({ pool: repoPool, connection, tipWallet, prices: PRICES, githubRepoId: '4201', wallet: donor.publicKey.toBase58(), mint: USDC.mint, amountBaseUnits: '6000000', log: silent })
  const signed = Transaction.from(Buffer.from(prepared.transaction, 'base64')); signed.sign(donor)
  const result = await submitTip({ pool: p, connection, id: prepared.id, transaction: signed.serialize().toString('base64'), waitMs: 0, sleep: async () => {}, landing: LANDING })
  assert.equal(result.state, 'confirmed'); assert.equal(result.received, '6000000')
  const tip = await loadTip(p, prepared.id)
  assert.equal(tip.status, 'confirmed'); assert.equal(tip.receivedAmount, '6000000'); assert.equal(tip.signature, bs58.encode(signed.signature))
  // A second submit (another replica, a retry) is idempotent; a different signature is refused.
  assert.equal((await submitTip({ pool: p, connection, id: prepared.id, transaction: signed.serialize().toString('base64'), waitMs: 0, landing: LANDING })).state, 'confirmed')
  // An unsigned tip past its blockhash expires; the worker does the same for anything abandoned.
  const stale = await prepareTip({ pool: repoPool, connection, tipWallet, prices: PRICES, githubRepoId: '4201', wallet: donor.publicKey.toBase58(), mint: USDC.mint, amountBaseUnits: '6000000', log: silent })
  assert.equal((await refreshTip(p, connection, await loadTip(p, stale.id))).state, 'prepared')
  connection.advance(200)
  await p.query(`update repo_tips set created_at = now() - interval '5 minutes' where id=$1`, [stale.id])
  assert.deepEqual(await createTipExpiry({ pool: p, connection }).runOnce(), [{ id: stale.id, state: 'expired' }])
  // A submitted tip whose transaction never landed expires only once the blockhash provably passed with no signature.
  connection.setMode('drop')
  const lost = await prepareTip({ pool: repoPool, connection, tipWallet, prices: PRICES, githubRepoId: '4201', wallet: donor.publicKey.toBase58(), mint: USDC.mint, amountBaseUnits: '6000000', log: silent })
  const lostSigned = Transaction.from(Buffer.from(lost.transaction, 'base64')); lostSigned.sign(donor)
  assert.equal((await submitTip({ pool: p, connection, id: lost.id, transaction: lostSigned.serialize().toString('base64'), waitMs: 0, landing: LANDING })).state, 'pending')
  connection.advance(200)
  assert.equal((await refreshTip(p, connection, await loadTip(p, lost.id))).state, 'expired')
})

dbTest('claim tips pays every confirmed tip per token to the verified payout wallet, settles, and cannot pay twice', async () => {
  const p = await resetDb()
  const signer = Keypair.generate(), payoutWallet = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [signer.publicKey.toBase58()]: OPERATING }, mints: { [USDC.mint]: splMint(), [NVDAX.mint]: xstockMint() } })
  await confirmedTip(p, connection, { token: USDC, amount: 6_000_000n, tipWallet: signer.publicKey })
  await confirmedTip(p, connection, { token: USDC, amount: 9_000_000n, tipWallet: signer.publicKey })
  await confirmedTip(p, connection, { token: NVDAX, amount: 3_000_000n, tipWallet: signer.publicKey })
  await confirmedTip(p, connection, { token: SOL, amount: 60_000_000n, tipWallet: signer.publicKey })
  const other = await confirmedTip(p, connection, { repo: 4202, token: USDC, amount: 7_000_000n, tipWallet: signer.publicKey })
  const review = await bindPayout(p, 4201, payoutWallet)
  const payouts = createTipPayouts({ pool: p, connection, signer, log: silent, landing: LANDING })
  await assert.rejects(payouts.payout({ githubRepoId: '4201', review, verifyAuthority: async () => ({ verified: true, permission: 'write', githubRepoId: '4201', verifiedAt: new Date().toISOString() }) }), /admin authority/)
  await assert.rejects(payouts.payout({ githubRepoId: '4201', review: { ...review, wallet: Keypair.generate().publicKey.toBase58() }, verifyAuthority: admin(4201) }), /Payout wallet changed/)
  const results = await payouts.payout({ githubRepoId: '4201', review, verifyAuthority: admin(4201) })
  assert.equal(results.length, 3)
  assert.ok(results.every(r => r.status === 'settled'), JSON.stringify(results))
  const byMint = Object.fromEntries(results.map(r => [r.mint, r.amount]))
  assert.deepEqual(byMint, { [USDC.mint]: '15000000', [NVDAX.mint]: '3000000', [SOL.mint]: '60000000' })
  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC.mint), payoutWallet).toBase58()
  const nvdaAta = getAssociatedTokenAddressSync(new PublicKey(NVDAX.mint), payoutWallet, false, TOKEN_2022_PROGRAM_ID).toBase58()
  assert.equal(connection.state.tokens.get(usdcAta).amount, 15_000_000n)
  assert.equal(connection.state.tokens.get(nvdaAta).amount, 3_000_000n)
  assert.equal(connection.state.lamports.get(payoutWallet.toBase58()), 60_000_000n)
  const { rows } = await p.query(`select github_repo_id::text as repo, status, count(*)::int as n from repo_tips group by 1,2 order by 1,2`)
  assert.deepEqual(rows, [{ repo: '4201', status: 'paid', n: 4 }, { repo: '4202', status: 'confirmed', n: 1 }])
  assert.equal((await p.query(`select count(*)::int as n from tip_transfers where status='settled' and kind='payout'`)).rows[0].n, 3)
  await assert.rejects(payouts.payout({ githubRepoId: '4201', review, verifyAuthority: admin(4201) }), /No tips are waiting/)
  // The other repository's tip is untouched and still fully covered.
  const coverage = await tipWalletCoverage(p, connection, signer.publicKey.toBase58())
  const usdc = coverage.find(c => c.mint === USDC.mint)
  assert.deepEqual([usdc.liability, usdc.balance, usdc.short], ['7000000', '7000000', false])
  assert.ok(other)
})

dbTest('payout guards: a shortfall (e.g. permanent-delegate burn) alerts and sends nothing; low operating SOL pauses; failed preflight reserves nothing', async () => {
  const p = await resetDb()
  const signer = Keypair.generate(), payoutWallet = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [signer.publicKey.toBase58()]: OPERATING }, mints: { [USDC.mint]: splMint(), [NVDAX.mint]: xstockMint() } })
  await confirmedTip(p, connection, { token: NVDAX, amount: 3_000_000n, tipWallet: signer.publicKey })
  await confirmedTip(p, connection, { repo: 4202, token: NVDAX, amount: 2_000_000n, tipWallet: signer.publicKey })
  const review = await bindPayout(p, 4201, payoutWallet)
  const ata = getAssociatedTokenAddressSync(new PublicKey(NVDAX.mint), signer.publicKey, false, TOKEN_2022_PROGRAM_ID).toBase58()
  connection.state.tokens.get(ata).amount = 4_000_000n // 1 NVDAx-unit short of the 5M owed across repositories
  const payouts = createTipPayouts({ pool: p, connection, signer, log: silent, landing: LANDING })
  const [short] = await payouts.payout({ githubRepoId: '4201', review, verifyAuthority: admin(4201) })
  assert.equal(short.status, 'failed'); assert.match(short.error, /below confirmed tips/)
  assert.equal(connection.sent.length, 0)
  assert.equal((await p.query(`select count(*)::int as n from graduation_alerts where kind='TIP_WALLET_SHORTFALL'`)).rows[0].n, 1)
  assert.equal((await p.query(`select count(*)::int as n from tip_transfers`)).rows[0].n, 0)
  connection.state.tokens.get(ata).amount = 5_000_000n
  connection.state.lamports.set(signer.publicKey.toBase58(), TIP_OPERATING_RESERVE_LAMPORTS - 1n)
  const [paused] = await payouts.payout({ githubRepoId: '4201', review, verifyAuthority: admin(4201) })
  assert.match(paused.error, /network funds/)
  connection.state.lamports.set(signer.publicKey.toBase58(), OPERATING)
  connection.state.mints.set(NVDAX.mint, xstockMint([feeExt(50)]))
  const [fee] = await payouts.payout({ githubRepoId: '4201', review, verifyAuthority: admin(4201) })
  assert.match(fee.error, /transfer fee/)
  assert.equal(connection.sent.length, 0)
  assert.equal((await p.query(`select count(*)::int as n from repo_tips where transfer_id is not null`)).rows[0].n, 0)
})

dbTest('refund: only the donor, only after refund_after, only unclaimed; a refunded tip can no longer be paid out', async () => {
  const p = await resetDb()
  const signer = Keypair.generate(), donor = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [signer.publicKey.toBase58()]: OPERATING }, mints: { [USDC.mint]: splMint() } })
  const early = await confirmedTip(p, connection, { token: USDC, amount: 6_000_000n, tipWallet: signer.publicKey, donor })
  const due = await confirmedTip(p, connection, { token: SOL, amount: 60_000_000n, tipWallet: signer.publicKey, donor, refundAfter: new Date(Date.now() - 1000) })
  const refunds = createTipRefunds({ pool: p, connection, signer, log: silent, landing: LANDING })
  await assert.rejects(refunds.refund({ donorWallet: donor.toBase58(), tipIds: [early] }), /90 days/)
  await assert.rejects(refunds.refund({ donorWallet: Keypair.generate().publicKey.toBase58(), tipIds: [due] }), /Only the wallet that sent/)
  const before = connection.state.lamports.get(donor.toBase58()) ?? 0n
  const [refunded] = await refunds.refund({ donorWallet: donor.toBase58(), tipIds: [due] })
  assert.equal(refunded.status, 'settled'); assert.equal(refunded.kind, 'refund')
  assert.equal(connection.state.lamports.get(donor.toBase58()) - before, 60_000_000n)
  assert.equal((await loadTip(p, due)).status, 'refunded')
  await assert.rejects(refunds.refund({ donorWallet: donor.toBase58(), tipIds: [due] }), /already paid, refunded/)
  // The maintainer's later claim only sees the remaining (unrefunded) tip.
  const review = await bindPayout(p, 4201, Keypair.generate().publicKey)
  const results = await createTipPayouts({ pool: p, connection, signer, log: silent, landing: LANDING }).payout({ githubRepoId: '4201', review, verifyAuthority: admin(4201) })
  assert.deepEqual(results.map(r => [r.mint, r.amount, r.status]), [[USDC.mint, '6000000', 'settled']])
})

dbTest('recovery settles a finalized pending transfer, aborts a provably expired one and releases its tips, and rebroadcasts only the stored bytes', async () => {
  const p = await resetDb()
  const signer = Keypair.generate(), payoutWallet = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [signer.publicKey.toBase58()]: OPERATING }, mints: { [USDC.mint]: splMint() } })
  const tipId = await confirmedTip(p, connection, { token: USDC, amount: 6_000_000n, tipWallet: signer.publicKey })
  const review = await bindPayout(p, 4201, payoutWallet)
  // Lost broadcast: the intent and reservation are durable, nothing landed.
  connection.setMode('drop')
  const [pending] = await createTipPayouts({ pool: p, connection, signer, log: silent, landing: LANDING }).payout({ githubRepoId: '4201', review, verifyAuthority: admin(4201) })
  assert.equal(pending.status, 'pending')
  assert.equal((await loadTip(p, tipId)).transferId, pending.id)
  await assert.rejects(createTipPayouts({ pool: p, connection, signer, log: silent, landing: LANDING }).payout({ githubRepoId: '4201', review, verifyAuthority: admin(4201) }), /No tips are waiting/)
  const recovery = createTipTransferRecovery({ pool: p, connection })
  const sentBefore = connection.sent.length
  assert.deepEqual((await recovery.runOnce()).map(r => r.status), ['pending'])
  assert.equal(connection.sent.length, sentBefore + 1)
  assert.equal(connection.sent.at(-1), pending.signature)
  connection.advance(500)
  assert.deepEqual((await recovery.runOnce()).map(r => r.status), ['aborted'])
  const released = await loadTip(p, tipId)
  assert.equal(released.transferId, null); assert.equal(released.status, 'confirmed')
  // Next claim lands; recovery of an already-landed intent settles it from the finalized receipt.
  connection.setMode('land')
  const [second] = await createTipPayouts({ pool: p, connection, signer, log: silent, landing: LANDING }).payout({ githubRepoId: '4201', review, verifyAuthority: admin(4201) })
  assert.equal(second.status, 'settled')
  await p.query(`update tip_transfers set status='pending', settled_at=null, receipt=null where id=$1`, [second.id])
  await p.query(`update repo_tips set status='confirmed', resolved_at=null where transfer_id=$1`, [second.id])
  assert.deepEqual((await recovery.runOnce()).map(r => r.status), ['settled'])
  assert.equal((await loadTip(p, tipId)).status, 'paid')
  // A receipt that differs from the durable intent is never settled.
  const receipt = connection.receipts.get(second.signature)
  const { rows: [row] } = await p.query(`select amount::text, signed_transaction as "signedTransaction", signature, source_wallet as "sourceWallet", recipient, mint, token_program as "tokenProgram" from tip_transfers where id=$1`, [second.id])
  assert.throws(() => verifyTransferReceipt(receipt, { ...row, amount: '6000001' }), /delta mismatch/)
  assert.throws(() => verifyTransferReceipt(receipt, { ...row, recipient: Keypair.generate().publicKey.toBase58() }), /missing from receipt|delta mismatch/)
})
