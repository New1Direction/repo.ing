import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import pg from 'pg'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemInstruction, Transaction, TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { tipToken } from '../src/tip-tokens.mjs'
import { MEMO_PROGRAM, acceptSignedTip, tipMemo, verifyTipReceipt } from '../src/tips.mjs'
import { TIP_OPERATING_RESERVE_LAMPORTS, createTipPayouts, createTipTransferRecovery, tipLiabilities, tipWalletCoverage, verifyTransferReceipt } from '../src/tip-transfers.mjs'
import { LIGHTHOUSE_PROGRAM } from '../src/launch-wallet-assertions.mjs'
import { PARTS_GLOBAL_CAP_CENTS, PARTS_MAX_GOAL_CENTS, PARTS_TOKENS, assertPledgeAmount, assertPledgeRoom, daysLeft, itemFill, linkDomain, parseUsdCents,
  partsToken, pledgeMemo, pledgeUsdCents, safePurchaseUrl, safeUpdateImageUrl, validateFundInput, validateUpdateInput } from '../src/parts-fund.mjs'
import { loadPledge, preparePledge, submitPledge } from '../src/parts-pledges.mjs'
import { cancelFund, collectFund, createFund, editFund, postUpdate } from '../src/parts-admin.mjs'
import { createPartsFundJobs, decideDueFunds, finalizeFunds, sendFundTransfers } from '../src/parts-settlement.mjs'
import { fetchUpdateImage, renderUpdateImage } from '../src/parts-images.mjs'
import sharp from 'sharp'
import { fakeChain, splMint } from './fixtures/tip-chain.mjs'

const SOL = tipToken(NATIVE_MINT.toBase58())
const USDC = tipToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const NVDAX = tipToken('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh')
const PRICES = { [SOL.mint]: 100, [USDC.mint]: 1 }
const silent = () => {}
const LANDING = { intervalMs: 0, maxMs: 1, sleep: async () => {} }
const DAY = 24 * 60 * 60_000
const program = ix => ix.programId.toBase58()
const list = (overrides = {}) => ({ title: 'Robot arm v2', description: 'Servos and a controller.\nShipping to the maintainer.',
  items: [{ name: 'MG996R servo', url: 'https://www.example.com/servo?ref=x', unitPrice: '12.50', quantity: 6 },
    { name: 'Controller board', unitPrice: '45', quantity: 1 }], ...overrides })

// ---------- List validation and caps ----------
test('parts list: goal is the exact sum in cents, deadline defaults to 30 days, text is trimmed and never HTML-interpreted', () => {
  const fund = validateFundInput(list())
  assert.equal(fund.goalCents, 6 * 1250 + 4500)
  assert.equal(fund.durationDays, 30)
  assert.equal(fund.description, 'Servos and a controller.\nShipping to the maintainer.')
  assert.deepEqual(fund.items.map(i => [i.position, i.name, i.url, i.unitPriceCents, i.quantity]),
    [[0, 'MG996R servo', 'https://www.example.com/servo?ref=x', 1250, 6], [1, 'Controller board', null, 4500, 1]])
  assert.equal(validateFundInput(list({ title: '  <b>Arm</b>  ' })).title, '<b>Arm</b>')
  assert.equal(validateFundInput(list({ durationDays: 7 })).durationDays, 7)
  assert.equal(validateFundInput(list({ durationDays: '60' })).durationDays, 60)
  for (const days of [6, 61, 1.5, 'x']) assert.throws(() => validateFundInput(list({ durationDays: days })), /7 to 60 days/)
  assert.equal(linkDomain('https://www.example.com/servo?ref=x'), 'example.com')
})

test('parts list rejects over-cap goals, bad quantities, long names, unsafe links and control characters', () => {
  assert.equal(PARTS_MAX_GOAL_CENTS, 500_000)
  assert.equal(validateFundInput(list({ items: [{ name: 'Rig', unitPrice: '5000', quantity: 1 }] })).goalCents, 500_000)
  assert.throws(() => validateFundInput(list({ items: [{ name: 'Rig', unitPrice: '5000.01', quantity: 1 }] })), /capped at \$5,000/)
  assert.throws(() => validateFundInput(list({ items: [{ name: 'Bolt', unitPrice: '10', quantity: 501 }] })), /capped/)
  for (const quantity of [0, 1000, 2.5, '3x', ' ', -1, null]) assert.throws(() => validateFundInput(list({ items: [{ name: 'Bolt', unitPrice: '1', quantity }] })), /quantity must be 1 to 999/)
  assert.equal(validateFundInput(list({ items: [{ name: 'x'.repeat(80), unitPrice: '1', quantity: 999 }] })).items[0].quantity, 999)
  assert.throws(() => validateFundInput(list({ items: [{ name: 'x'.repeat(81), unitPrice: '1', quantity: 1 }] })), /limited to 80/)
  for (const unitPrice of ['0', '0.00', '1.234', '-1', '1e3', 12, '', '$5']) assert.throws(() => validateFundInput(list({ items: [{ name: 'A', unitPrice, quantity: 1 }] })), /price|needs a price/)
  for (const url of ['http://example.com/a', 'javascript:alert(1)', 'https://user:pw@example.com', 'https://example.com:8443/x', 'data:text/html,hi', 'https://localhost/x', 'ftp://x.com'])
    assert.throws(() => safePurchaseUrl(url), /https:\/\//, url)
  assert.throws(() => validateFundInput(list({ title: 'ab' })), /at least 3/)
  assert.throws(() => validateFundInput(list({ title: 'Arm‮evil' })), /unsupported characters/)
  assert.throws(() => validateFundInput(list({ title: 'Two\nlines' })), /unsupported characters/)
  assert.throws(() => validateFundInput(list({ items: [] })), /at least one part/)
  assert.throws(() => validateFundInput(list({ items: Array.from({ length: 26 }, () => ({ name: 'A', unitPrice: '1', quantity: 1 })) })), /up to 25/)
  assert.throws(() => validateFundInput(list({ description: 'x'.repeat(1001) })), /limited to 1000/)
  assert.equal(parseUsdCents('0.5'), 50); assert.equal(parseUsdCents('12.05'), 1205); assert.equal(parseUsdCents(' 7 '), 700)
})

test('build updates: text ≤ 1000 chars, up to 4 GitHub or Imgur image links only', () => {
  const ok = ['https://i.imgur.com/abc123.png', 'https://raw.githubusercontent.com/o/r/main/build.jpg',
    'https://github.com/user-attachments/assets/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b', 'https://github.com/o/r/raw/main/docs/arm.png']
  assert.deepEqual(validateUpdateInput({ body: 'Arm assembled!', images: ok }).images, ok)
  for (const bad of ['https://imgur.com/gallery/x', 'http://i.imgur.com/a.png', 'https://evil.com/a.png', 'https://github.com/o/r/blob/main/a.png',
    'https://github.com/login', 'javascript:alert(1)', 'https://i.imgur.com:444/a.png', 'https://raw.githubusercontent.com/a.png#x'])
    assert.throws(() => safeUpdateImageUrl(bad), /GitHub or Imgur/, bad)
  assert.throws(() => validateUpdateInput({ body: 'x', images: [...ok, ok[0].replace('abc', 'abd')] }), /up to 4/)
  assert.throws(() => validateUpdateInput({ body: 'x'.repeat(1001) }), /limited to 1000/)
  assert.throws(() => validateUpdateInput({ body: '   ' }), /Enter a build update/)
})

test('update images are fetched only through allowed hosts (redirects included) and re-encoded as WebP', async () => {
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3a7' } }).png().toBuffer()
  const hops = { 'https://github.com/user-attachments/assets/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b': 'https://private-user-images.githubusercontent.com/1/a.png?jwt=x',
    'https://i.imgur.com/evil.png': 'https://evil.example/a.png' }
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'manual')
    if (hops[url]) return new Response(null, { status: 302, headers: { location: hops[url] } })
    if (url.includes('svg')) return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { status: 200 })
    return new Response(png, { status: 200 })
  }
  const bytes = await fetchUpdateImage('https://github.com/user-attachments/assets/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b', fetchImpl)
  const webp = await renderUpdateImage(bytes)
  assert.equal((await sharp(webp).metadata()).format, 'webp')
  await assert.rejects(fetchUpdateImage('https://i.imgur.com/evil.png', fetchImpl), /redirect is not allowed/)
  await assert.rejects(fetchUpdateImage('https://evil.example/a.png', fetchImpl), /GitHub or Imgur/)
  await assert.rejects(fetchUpdateImage('https://i.imgur.com/x.svg', fetchImpl).then(renderUpdateImage), /Unsupported|Input buffer/)
})

// ---------- Pledge amounts and caps ----------
test('pledges accept USDC or SOL only, start at $5 in base units, and fix USD value at pledge time in whole cents', () => {
  assert.deepEqual(PARTS_TOKENS.map(t => t.symbol), ['SOL', 'USDC'])
  assert.equal(partsToken(USDC.mint), USDC)
  assert.throws(() => partsToken(NVDAX.mint), /USDC or SOL/)
  assert.throws(() => assertPledgeAmount(SOL, 49_999_999n, 100), /Pledges start at \$5/)
  assert.equal(assertPledgeAmount(SOL, 50_000_000n, 100), 500)
  assert.equal(assertPledgeAmount(USDC, 5_000_601n, 0.99988), 500)
  assert.equal(pledgeUsdCents(SOL, 123_456_789n, 142.37), 1758)
  assert.throws(() => assertPledgeAmount(USDC, 10_000_000n, undefined), /price is unavailable/)
})

test('per-list cap: pledges never pass the goal except a final $5 minimum; global cap across all lists', () => {
  assert.equal(assertPledgeRoom({ goalCents: 10_000, held: 2_000, cents: 8_000 }), 8_000)
  assert.throws(() => assertPledgeRoom({ goalCents: 10_000, held: 2_000, cents: 8_001 }), /Only \$80 is left/)
  assert.equal(assertPledgeRoom({ goalCents: 10_000, held: 9_800, cents: 500 }), 200) // last pledge may be the $5 minimum
  assert.throws(() => assertPledgeRoom({ goalCents: 10_000, held: 9_800, cents: 501 }), /Only \$2 is left/)
  assert.throws(() => assertPledgeRoom({ goalCents: 10_000, held: 10_000, cents: 500 }), /fully pledged/)
  assert.throws(() => assertPledgeRoom({ goalCents: 10_000, held: 0, cents: 600, globalHeld: PARTS_GLOBAL_CAP_CENTS - 500 }), /capacity/)
})

test('earmark fill: earmarks fill their part first, excess joins the pool, the pool fills in proportion with exact cents', () => {
  const items = [{ id: 'a', unitPriceCents: 1000, quantity: 3 }, { id: 'b', unitPriceCents: 2000, quantity: 1 }, { id: 'c', unitPriceCents: 333, quantity: 3 }]
  // Costs: a 3000, b 2000, c 999 → goal 5999.
  const none = itemFill(items, [])
  assert.deepEqual(none.map(i => [i.filledCents, i.funded]), [[0, false], [0, false], [0, false]])
  const earmarkB = itemFill(items, [{ usdCents: 2500, itemId: 'b' }]) // b full; 500 excess to the pool
  assert.equal(earmarkB[1].funded, true); assert.equal(earmarkB[1].filledCents, 2000); assert.equal(earmarkB[1].earmarkedCents, 2500)
  assert.equal(earmarkB[0].filledCents + earmarkB[2].filledCents, 500)
  assert.equal(earmarkB[0].filledCents, 375) // 3000/3999 of 500, largest remainder
  const general = itemFill(items, [{ usdCents: 1001, itemId: null }, { usdCents: 999, itemId: 'zzz' }]) // unknown item → pool
  assert.equal(general.reduce((s, i) => s + i.filledCents, 0), 2000)
  assert.ok(general.every(i => !i.funded))
  const full = itemFill(items, [{ usdCents: 3000, itemId: null }, { usdCents: 3100, itemId: 'a' }])
  assert.ok(full.every(i => i.funded && i.percent === 100)); assert.deepEqual(full.map(i => i.filledCents), [3000, 2000, 999])
  assert.equal(daysLeft(Date.now() + 1.2 * DAY), 2); assert.equal(daysLeft(Date.now() - 1), 0)
})

// ---------- Prepare: exact instructions (fake pool, fake chain) ----------
function prepPool({ goalCents = 10_000, held = '0', global = '0', openByWallet = 0, revision = 1, deadline = new Date(Date.now() + 10 * DAY), status = 'open', items = ['11111111-1111-4111-8111-111111111111'] } = {}) {
  const inserted = []
  const fundRow = { id: 'f', githubRepoId: '42', revision, status, goalCents, deadline }
  const query = async (sql, params) => {
    if (/^(begin|commit|rollback)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] }
    if (/from parts_funds where id=/.test(sql)) return { rows: [fundRow] }
    if (/from parts_fund_items/.test(sql)) return { rows: items.includes(params[0]) ? [{}] : [], rowCount: items.includes(params[0]) ? 1 : 0 }
    if (/from markets/.test(sql)) return { rows: [{ repoId: params[0] }] }
    if (/from parts_pledges where status in/.test(sql)) return { rows: [{ list: held, global, openByWallet }] }
    if (/insert into parts_pledges/.test(sql)) { inserted.push(params); return { rows: [], rowCount: 1 } }
    throw Error(`unexpected query ${sql}`)
  }
  return { inserted, query, connect: async () => ({ query, release() {} }) }
}
const FUND = '22222222-2222-4222-8222-222222222222'

test('pledge prepare: unsigned, priority-fee USDC transfer_checked into the tip wallet with the repoing-parts memo, persisted with USD at pledge time', async () => {
  const donor = Keypair.generate(), tipWallet = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [donor.publicKey.toBase58()]: 1_000_000_000 }, mints: { [USDC.mint]: splMint() } })
  const donorAta = getAssociatedTokenAddressSync(new PublicKey(USDC.mint), donor.publicKey)
  connection.tokenAccount(donorAta.toBase58(), USDC.mint, donor.publicKey.toBase58(), USDC.program, 100_000_000n)
  const pool = prepPool(), itemId = '11111111-1111-4111-8111-111111111111'
  const prepared = await preparePledge({ pool, connection, tipWallet, prices: PRICES, fundId: FUND, revision: 1, itemId, wallet: donor.publicKey.toBase58(),
    mint: USDC.mint, amountBaseUnits: '25000000', log: silent })
  const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
  assert.ok(tx.feePayer.equals(donor.publicKey)); assert.equal(tx.signatures.length, 1); assert.equal(tx.signatures[0].signature, null)
  assert.deepEqual(tx.instructions.map(program), [ComputeBudgetProgram.programId, ComputeBudgetProgram.programId, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, MEMO_PROGRAM].map(k => k.toBase58()))
  const destination = getAssociatedTokenAddressSync(new PublicKey(USDC.mint), tipWallet)
  assert.deepEqual(tx.instructions[2].keys.map(k => k.pubkey.toBase58()), [donor.publicKey, destination, tipWallet, new PublicKey(USDC.mint), new PublicKey('11111111111111111111111111111111'), TOKEN_PROGRAM_ID].map(k => k.toBase58()))
  assert.equal(tx.instructions[3].data[0], 12); assert.equal(tx.instructions[3].data.readBigUInt64LE(1), 25_000_000n); assert.equal(tx.instructions[3].data[9], 6)
  assert.deepEqual(tx.instructions[3].keys.map(k => k.pubkey.toBase58()), [donorAta, new PublicKey(USDC.mint), destination, donor.publicKey].map(k => k.toBase58()))
  assert.equal(tx.instructions[4].data.toString(), `repoing-parts:${prepared.id}`); assert.equal(tx.instructions[4].keys.length, 0)
  assert.equal(prepared.usdCents, 2500)
  const [row] = pool.inserted
  assert.deepEqual(row.slice(0, 13), [prepared.id, FUND, '42', itemId, donor.publicKey.toBase58(), tipWallet.toBase58(), USDC.mint, USDC.program, 6, 'USDC', '25000000', 2500, 1])
  assert.equal(row[13], Buffer.from(tx.serializeMessage()).toString('base64'))
  // SOL: a plain system transfer + memo.
  const sol = await preparePledge({ pool, connection, tipWallet, prices: PRICES, fundId: FUND, revision: 1, wallet: donor.publicKey.toBase58(), mint: SOL.mint, amountBaseUnits: '60000000', log: silent })
  const solTx = Transaction.from(Buffer.from(sol.transaction, 'base64'))
  const decoded = SystemInstruction.decodeTransfer(solTx.instructions[2])
  assert.ok(decoded.fromPubkey.equals(donor.publicKey) && decoded.toPubkey.equals(tipWallet)); assert.equal(BigInt(decoded.lamports), 60_000_000n)
  assert.equal(solTx.instructions[3].data.toString(), pledgeMemo(sol.id)); assert.equal(sol.usdCents, 600)
})

test('pledge prepare refuses closed, changed, full or foreign lists, wrong tokens and spam before inserting', async () => {
  const donor = Keypair.generate(), tipWallet = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [donor.publicKey.toBase58()]: 10_000_000_000 }, mints: { [USDC.mint]: splMint() } })
  const args = { connection, tipWallet, prices: PRICES, fundId: FUND, revision: 1, wallet: donor.publicKey.toBase58(), mint: SOL.mint, amountBaseUnits: '60000000', log: silent }
  const cases = [
    [prepPool({ status: 'funded' }), {}, /closed to new pledges/],
    [prepPool({ deadline: new Date(Date.now() + 60_000) }), {}, /closed to new pledges/],
    [prepPool({ revision: 2 }), {}, /changed/],
    [prepPool({ held: '10000' }), {}, /fully pledged/],
    [prepPool({ held: '9000' }), { amountBaseUnits: '1100000000' }, /Only \$10 is left/],
    [prepPool({ openByWallet: 2 }), {}, /pending pledge/],
    [prepPool({ global: String(PARTS_GLOBAL_CAP_CENTS) }), {}, /capacity/],
    [prepPool(), { mint: NVDAX.mint }, /USDC or SOL/],
    [prepPool(), { amountBaseUnits: '49999999' }, /start at \$5/],
    [prepPool(), { itemId: '33333333-3333-4333-8333-333333333333' }, /Choose a part/],
    [prepPool(), { fundId: 'nope' }, /not found/],
    [prepPool(), { wallet: tipWallet.toBase58() }, /cannot pledge/],
    [prepPool(), { tipWallet: null }, /not enabled/],
    [prepPool(), { amountBaseUnits: '20000000000' }, /does not hold enough SOL/],
  ]
  for (const [pool, overrides, error] of cases) {
    await assert.rejects(preparePledge({ ...args, pool, ...overrides }), error)
    assert.equal(pool.inserted.length, 0)
  }
})

test('pledge submit accepts the exact reviewed pledge (or a read-only Lighthouse assertion) and its receipt needs the pledge memo', async () => {
  const donor = Keypair.generate(), tipWallet = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [donor.publicKey.toBase58()]: 1_000_000_000 }, mints: { [USDC.mint]: splMint() } })
  connection.tokenAccount(getAssociatedTokenAddressSync(new PublicKey(USDC.mint), donor.publicKey).toBase58(), USDC.mint, donor.publicKey.toBase58(), USDC.program, 100_000_000n)
  const pool = prepPool()
  const prepared = await preparePledge({ pool, connection, tipWallet, prices: PRICES, fundId: FUND, revision: 1, wallet: donor.publicKey.toBase58(), mint: USDC.mint, amountBaseUnits: '6000000', log: silent })
  const p = pool.inserted[0]
  const pledge = { id: p[0], donorWallet: p[4], tipWallet: p[5], mint: p[6], tokenProgram: p[7], decimals: p[8], requestedAmount: p[10], message: p[13], signature: null }
  const unsigned = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
  const sign = tx => { tx.sign(donor); return tx.serialize().toString('base64') }
  const rebuilt = instructions => new Transaction({ feePayer: unsigned.feePayer, recentBlockhash: unsigned.recentBlockhash }).add(...instructions)
  const exact = sign(Transaction.from(unsigned.serialize({ requireAllSignatures: false })))
  assert.ok(acceptSignedTip(pledge, exact).signature)
  const lighthouse = (data, writable = false) => new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM), data, keys: [{ pubkey: donor.publicKey, isSigner: false, isWritable: writable }] })
  assert.ok(acceptSignedTip(pledge, sign(rebuilt([...unsigned.instructions, lighthouse(Buffer.from([2, 0, 0, 0]))]))).signature)
  assert.throws(() => acceptSignedTip(pledge, sign(rebuilt([...unsigned.instructions, lighthouse(Buffer.from([0, 0, 0, 0]))]))), /altered/)
  const tipMemoIx = new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(tipMemo(pledge.id)) })
  assert.throws(() => acceptSignedTip(pledge, sign(rebuilt([...unsigned.instructions.slice(0, 4), tipMemoIx]))), /altered/)
  const changed = new TransactionInstruction({ ...unsigned.instructions[3], data: Buffer.from(unsigned.instructions[3].data) }); changed.data.writeBigUInt64LE(1n, 1)
  assert.throws(() => acceptSignedTip(pledge, sign(rebuilt([...unsigned.instructions.slice(0, 3), changed, unsigned.instructions[4]]))), /altered/)
  // Receipt: the tip wallet received exactly the amount, with this pledge's memo (a tip memo does not count).
  const raw = Buffer.from(exact, 'base64'), signature = await connection.sendRawTransaction(raw)
  const receipt = connection.receipts.get(signature)
  const submitted = { ...pledge, signature, signedTransaction: exact }
  assert.equal(verifyTipReceipt(receipt, submitted, pledgeMemo(pledge.id)).received, 6_000_000n)
  assert.throws(() => verifyTipReceipt(receipt, submitted), /memo is missing/)
  assert.throws(() => verifyTipReceipt(receipt, { ...submitted, requestedAmount: '6000001' }, pledgeMemo(pledge.id)), /different amount/)
})

test('parts fund API is disabled without TIP_WALLET_SECRET_KEY', async () => {
  const saved = process.env.TIP_WALLET_SECRET_KEY
  delete process.env.TIP_WALLET_SECRET_KEY
  try {
    const { POST } = await import('../app/api/parts-fund/route.js')
    for (const action of ['view', 'prepare', 'submit']) {
      const response = await POST(new Request('http://localhost/api/parts-fund', { method: 'POST', body: JSON.stringify({ action, fundId: FUND }) }))
      assert.equal(response.status, 503)
      assert.equal((await response.json()).error, 'Parts funds are not enabled')
    }
  } finally { if (saved !== undefined) process.env.TIP_WALLET_SECRET_KEY = saved }
})

// ---------- Real PostgreSQL: lists, all-or-nothing settlement, recovery ----------
const dbUrl = process.env.PARTS_TEST_DATABASE_URL
const dbTest = (name, fn) => test(name, { skip: !dbUrl }, fn)
let pgPool
async function db() {
  if (pgPool) return pgPool
  const url = new URL(dbUrl)
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Disposable local test database required')
  pgPool = new pg.Pool({ connectionString: url.toString() })
  return pgPool
}
test.after(async () => { await pgPool?.end() })
const REPOS = [4301, 4302]
async function resetDb() {
  const p = await db()
  for (const sql of ['delete from parts_updates', 'delete from parts_pledges', 'delete from parts_transfers',
    'delete from parts_fund_items', 'delete from parts_funds', 'delete from repo_tips', 'delete from tip_transfers',
    `delete from repo_beneficiaries where github_repo_id in (${REPOS})`, "delete from graduation_alerts where kind like 'PARTS_%' or kind='TIP_WALLET_SHORTFALL'"]) await p.query(sql)
  for (const id of REPOS) await p.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at)
    values($1,'fixture',$2,$3,0,0,false,now()) on conflict do nothing`, [id, `parts-${id}`, `fixture/parts-${id}`])
  return p
}
// Every repo "has a market" for these tests (markets rows need launch fixtures unrelated to parts funds).
const marketPool = p => ({ query: (sql, params) => /from markets/.test(sql) ? { rows: [{ repoId: String(params[0]) }] } : p.query(sql, params), connect: () => p.connect() })
const admin = repoId => async () => ({ verified: true, permission: 'admin', githubRepoId: String(repoId), githubUserId: '77', verifiedAt: new Date().toISOString() })
async function bindPayout(p, repo, wallet) {
  const { rows: [row] } = await p.query(`insert into repo_beneficiaries(github_repo_id, github_user_id, wallet) values($1,77,$2) returning bound_at`, [repo, wallet.toBase58()])
  return { repoId: String(repo), wallet: wallet.toBase58(), boundAt: new Date(row.bound_at).toISOString() }
}
const OPERATING = TIP_OPERATING_RESERVE_LAMPORTS + 50_000_000n
async function items(p, fundId) { return (await p.query('select id from parts_fund_items where fund_id=$1 order by position', [fundId])).rows.map(r => r.id) }
// A pledge that already landed (tokens now held by the tip wallet) and is confirmed.
async function confirmedPledge(p, connection, { fundId, repo = 4301, token = USDC, amount, usdCents, tipWallet, donor = Keypair.generate().publicKey, itemId = null }) {
  const id = crypto.randomUUID()
  await p.query(`insert into parts_pledges(id, fund_id, github_repo_id, item_id, donor_wallet, tip_wallet, mint, token_program, decimals, symbol, requested_amount,
      received_amount, usd_cents, usd_price, status, message, transaction, last_valid_block_height, signature, signed_transaction, confirmed_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,1,'confirmed','m','t',1,$13,'s',now())`,
  [id, fundId, repo, itemId, donor.toBase58(), tipWallet.toBase58(), token.mint, token.program, token.decimals, token.symbol, String(amount), usdCents,
    bs58.encode(Buffer.from(crypto.getRandomValues(new Uint8Array(64))))])
  if (token === SOL) connection.state.lamports.set(tipWallet.toBase58(), (connection.state.lamports.get(tipWallet.toBase58()) ?? 0n) + BigInt(amount))
  else {
    const ata = getAssociatedTokenAddressSync(new PublicKey(token.mint), tipWallet, false, new PublicKey(token.program)).toBase58()
    connection.tokenAccount(ata, token.mint, tipWallet.toBase58(), token.program, (connection.state.tokens.get(ata)?.amount ?? 0n) + BigInt(amount))
  }
  return id
}
const statusOf = async (p, fundId) => (await p.query('select status, close_reason as reason, settled_at is not null as settled, payout_wallet as payout from parts_funds where id=$1', [fundId])).rows[0]
const later = (days = 31) => () => Date.now() + days * DAY

dbTest('create → one active list per repo, maintainer + payout wallet required; edit only before the first pledge; real prepare → submit → confirmed', async () => {
  const p = await resetDb(), mp = marketPool(p)
  const signer = Keypair.generate(), donor = Keypair.generate()
  const connection = fakeChain({ lamports: { [donor.publicKey.toBase58()]: 1_000_000_000, [signer.publicKey.toBase58()]: OPERATING }, mints: { [USDC.mint]: splMint() } })
  connection.tokenAccount(getAssociatedTokenAddressSync(new PublicKey(USDC.mint), donor.publicKey).toBase58(), USDC.mint, donor.publicKey.toBase58(), USDC.program, 500_000_000n)
  await assert.rejects(createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) }), /payout wallet/)
  await bindPayout(p, 4301, Keypair.generate().publicKey)
  await assert.rejects(createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: async () => ({ verified: true, permission: 'write', githubRepoId: '4301', verifiedAt: new Date().toISOString() }) }), /admin authority/)
  await assert.rejects(createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: admin(4302) }), /admin authority/)
  const { id: fundId, goalCents } = await createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) })
  assert.equal(goalCents, 12_000)
  await assert.rejects(createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) }), /already has an active parts list/)
  const edited = await editFund({ pool: mp, fundId, githubRepoId: '4301', input: list({ title: 'Robot arm v3', items: [{ name: 'Servo', unitPrice: '20', quantity: 5 }] }), verifyAuthority: admin(4301) })
  assert.deepEqual([edited.revision, edited.goalCents], [2, 10_000])
  await assert.rejects(preparePledge({ pool: mp, connection, tipWallet: signer.publicKey, prices: PRICES, fundId, revision: 1, wallet: donor.publicKey.toBase58(), mint: USDC.mint, amountBaseUnits: '6000000', log: silent }), /changed/)
  const [servo] = await items(p, fundId)
  const prepared = await preparePledge({ pool: mp, connection, tipWallet: signer.publicKey, prices: PRICES, fundId, revision: 2, itemId: servo, wallet: donor.publicKey.toBase58(), mint: USDC.mint, amountBaseUnits: '60000000', log: silent })
  await assert.rejects(editFund({ pool: mp, fundId, githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) }), /after the first pledge/)
  const signed = Transaction.from(Buffer.from(prepared.transaction, 'base64')); signed.sign(donor)
  const result = await submitPledge({ pool: p, connection, id: prepared.id, transaction: signed.serialize().toString('base64'), waitMs: 0, landing: LANDING })
  assert.deepEqual([result.state, result.received], ['confirmed', '60000000'])
  const pledge = await loadPledge(p, prepared.id)
  assert.deepEqual([pledge.status, pledge.usdCents, pledge.itemId, pledge.receivedAmount], ['confirmed', 6000, servo, '60000000'])
  // Room left is $40; a $41 pledge is refused, and one wallet cannot hold more than two in-flight pledges.
  await assert.rejects(preparePledge({ pool: mp, connection, tipWallet: signer.publicKey, prices: PRICES, fundId, revision: 2, wallet: donor.publicKey.toBase58(), mint: USDC.mint, amountBaseUnits: '41000000', log: silent }), /Only \$40 is left/)
  await preparePledge({ pool: mp, connection, tipWallet: signer.publicKey, prices: PRICES, fundId, revision: 2, wallet: donor.publicKey.toBase58(), mint: USDC.mint, amountBaseUnits: '5000000', log: silent })
  await preparePledge({ pool: mp, connection, tipWallet: signer.publicKey, prices: PRICES, fundId, revision: 2, wallet: donor.publicKey.toBase58(), mint: USDC.mint, amountBaseUnits: '5000000', log: silent })
  await assert.rejects(preparePledge({ pool: mp, connection, tipWallet: signer.publicKey, prices: PRICES, fundId, revision: 2, wallet: donor.publicKey.toBase58(), mint: USDC.mint, amountBaseUnits: '5000000', log: silent }), /pending pledge/)
  // The two unsigned pledges hold the list open past its deadline until they provably expire.
  assert.deepEqual(await decideDueFunds({ pool: p, now: later() }), [])
  connection.advance(200)
  await p.query(`update parts_pledges set created_at = now() - interval '5 minutes' where status='prepared'`)
  const jobs = await createPartsFundJobs({ pool: p, connection, now: later() }).runOnce()
  assert.equal(jobs.pledges.length, 2); assert.ok(jobs.pledges.every(r => r.state === 'expired'))
  assert.deepEqual(jobs.decided, [{ id: fundId, status: 'failed' }])
  // Updates are only for funded lists.
  await assert.rejects(postUpdate({ pool: p, fundId, githubRepoId: '4301', input: { body: 'hi' }, verifyAuthority: admin(4301) }), /once the parts list is funded/)
})

dbTest('deadline met → funded: one payout per token to the pinned payout wallet, settled from receipts, never twice', async () => {
  const p = await resetDb(), mp = marketPool(p)
  const signer = Keypair.generate(), payoutWallet = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [signer.publicKey.toBase58()]: OPERATING }, mints: { [USDC.mint]: splMint() } })
  await bindPayout(p, 4301, payoutWallet)
  const { id: fundId } = await createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) }) // goal $120
  await confirmedPledge(p, connection, { fundId, amount: 70_000_000n, usdCents: 7000, tipWallet: signer.publicKey })
  await confirmedPledge(p, connection, { fundId, amount: 30_000_000n, usdCents: 3000, tipWallet: signer.publicKey })
  await confirmedPledge(p, connection, { fundId, token: SOL, amount: 200_000_000n, usdCents: 2000, tipWallet: signer.publicKey })
  // Not due yet: nothing decided, nothing sent.
  assert.deepEqual(await createPartsFundJobs({ pool: p, connection, signer, log: silent }).runOnce().then(r => [r.decided, r.transfers, r.settled]), [[], [], []])
  const run = await createPartsFundJobs({ pool: p, connection, signer, now: later(), log: silent }).runOnce()
  assert.deepEqual(run.decided, [{ id: fundId, status: 'funded' }])
  assert.equal(run.transfers.length, 2); assert.ok(run.transfers.every(t => t.status === 'settled' && t.kind === 'payout'), JSON.stringify(run.transfers))
  assert.deepEqual(run.settled.map(r => r.id), [fundId])
  assert.equal(connection.state.tokens.get(getAssociatedTokenAddressSync(new PublicKey(USDC.mint), payoutWallet).toBase58()).amount, 100_000_000n)
  assert.equal(connection.state.lamports.get(payoutWallet.toBase58()), 200_000_000n)
  assert.deepEqual(await statusOf(p, fundId), { status: 'funded', reason: 'deadline_met', settled: true, payout: payoutWallet.toBase58() })
  assert.deepEqual((await p.query(`select status, count(*)::int as n from parts_pledges group by 1`)).rows, [{ status: 'paid', n: 3 }])
  const again = await sendFundTransfers({ pool: p, connection, signer, fundId, log: silent })
  assert.deepEqual(again, [])
  // Funded lists take build updates (text + up to 4 images), and a new list can start once this one settled.
  await postUpdate({ pool: p, fundId, githubRepoId: '4301', input: { body: 'Arm assembled', images: ['https://i.imgur.com/abc.png'] }, verifyAuthority: admin(4301) })
  assert.ok((await createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) })).id)
})

dbTest('deadline missed → failed: every backer refunded per token to their own wallet; late pledges refunded too', async () => {
  const p = await resetDb(), mp = marketPool(p)
  const signer = Keypair.generate(), alice = Keypair.generate().publicKey, bob = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [signer.publicKey.toBase58()]: OPERATING }, mints: { [USDC.mint]: splMint() } })
  await bindPayout(p, 4301, Keypair.generate().publicKey)
  const { id: fundId } = await createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) })
  await confirmedPledge(p, connection, { fundId, amount: 10_000_000n, usdCents: 1000, tipWallet: signer.publicKey, donor: alice })
  await confirmedPledge(p, connection, { fundId, amount: 15_000_000n, usdCents: 1500, tipWallet: signer.publicKey, donor: alice })
  await confirmedPledge(p, connection, { fundId, token: SOL, amount: 100_000_000n, usdCents: 1000, tipWallet: signer.publicKey, donor: alice })
  await confirmedPledge(p, connection, { fundId, amount: 8_000_000n, usdCents: 800, tipWallet: signer.publicKey, donor: bob })
  const decided = await decideDueFunds({ pool: p, now: later() })
  assert.deepEqual(decided, [{ id: fundId, status: 'failed' }])
  // A pledge that lands after the list closed is still refunded.
  await confirmedPledge(p, connection, { fundId, amount: 5_000_000n, usdCents: 500, tipWallet: signer.publicKey, donor: bob })
  const transfers = await sendFundTransfers({ pool: p, connection, signer, log: silent })
  assert.equal(transfers.length, 3)
  assert.ok(transfers.every(t => t.status === 'settled' && t.kind === 'refund'))
  const usdc = owner => connection.state.tokens.get(getAssociatedTokenAddressSync(new PublicKey(USDC.mint), owner).toBase58())?.amount
  assert.equal(usdc(alice), 25_000_000n); assert.equal(usdc(bob), 13_000_000n)
  assert.equal(connection.state.lamports.get(alice.toBase58()), 100_000_000n)
  await finalizeFunds({ pool: p })
  assert.deepEqual(await statusOf(p, fundId), { status: 'failed', reason: 'deadline_missed', settled: true, payout: null })
  assert.equal((await p.query(`select count(*)::int as n from parts_pledges where status <> 'refunded'`)).rows[0].n, 0)
})

dbTest('cancel → refunds; close & collect only once confirmed pledges meet the goal, to the reviewed wallet', async () => {
  const p = await resetDb(), mp = marketPool(p)
  const signer = Keypair.generate(), payoutWallet = Keypair.generate().publicKey, donor = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [signer.publicKey.toBase58()]: OPERATING }, mints: { [USDC.mint]: splMint() } })
  const review = await bindPayout(p, 4301, payoutWallet)
  const { id: fundId } = await createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) })
  await confirmedPledge(p, connection, { fundId, amount: 60_000_000n, usdCents: 6000, tipWallet: signer.publicKey, donor })
  const collectReview = { ...review, fundId }
  await assert.rejects(collectFund({ pool: p, fundId, githubRepoId: '4301', review: collectReview, verifyAuthority: admin(4301) }), /reach the goal/)
  await confirmedPledge(p, connection, { fundId, amount: 60_000_000n, usdCents: 6000, tipWallet: signer.publicKey })
  await assert.rejects(collectFund({ pool: p, fundId, githubRepoId: '4301', review: { ...collectReview, wallet: Keypair.generate().publicKey.toBase58() }, verifyAuthority: admin(4301) }), /Payout wallet changed/)
  await assert.rejects(collectFund({ pool: p, fundId, githubRepoId: '4301', review: { ...collectReview, fundId: crypto.randomUUID() }, verifyAuthority: admin(4301) }), /review expired/)
  await assert.rejects(collectFund({ pool: p, fundId, githubRepoId: '4302', review: collectReview, verifyAuthority: admin(4302) }), /review expired|not found/)
  assert.deepEqual(await collectFund({ pool: p, fundId, githubRepoId: '4301', review: collectReview, verifyAuthority: admin(4301) }), { id: fundId, status: 'funded' })
  const [paid] = await sendFundTransfers({ pool: p, connection, signer, fundId, log: silent })
  assert.deepEqual([paid.kind, paid.status, paid.amount], ['payout', 'settled', '120000000'])
  await finalizeFunds({ pool: p })
  assert.deepEqual(await statusOf(p, fundId), { status: 'funded', reason: 'collected', settled: true, payout: payoutWallet.toBase58() })
  await assert.rejects(cancelFund({ pool: p, fundId, githubRepoId: '4301', verifyAuthority: admin(4301) }), /closed/)
  // A second list is cancelled: its backer is refunded automatically.
  const { id: second } = await createFund({ pool: marketPool(p), githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) })
  await confirmedPledge(p, connection, { fundId: second, amount: 7_000_000n, usdCents: 700, tipWallet: signer.publicKey, donor })
  await assert.rejects(cancelFund({ pool: p, fundId: second, githubRepoId: '4302', verifyAuthority: admin(4302) }), /not found/)
  await cancelFund({ pool: p, fundId: second, githubRepoId: '4301', verifyAuthority: admin(4301) })
  await assert.rejects(collectFund({ pool: p, fundId: second, githubRepoId: '4301', review: { ...review, fundId: second }, verifyAuthority: admin(4301) }), /closed/)
  const run = await createPartsFundJobs({ pool: p, connection, signer, log: silent }).runOnce()
  assert.deepEqual(run.transfers.map(t => [t.kind, t.status, t.recipient ?? donor.toBase58()]), [['refund', 'settled', donor.toBase58()]])
  assert.deepEqual(run.settled.map(r => r.status), ['cancelled'])
})

dbTest('liabilities: pledges count toward tip-wallet coverage, and a tip payout cannot spend tokens owed to backers', async () => {
  const p = await resetDb(), mp = marketPool(p)
  const signer = Keypair.generate()
  const connection = fakeChain({ lamports: { [signer.publicKey.toBase58()]: OPERATING }, mints: { [USDC.mint]: splMint() } })
  const review = await bindPayout(p, 4301, Keypair.generate().publicKey)
  const { id: fundId } = await createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) })
  await confirmedPledge(p, connection, { fundId, amount: 20_000_000n, usdCents: 2000, tipWallet: signer.publicKey })
  await p.query(`insert into repo_tips(id, github_repo_id, donor_wallet, tip_wallet, mint, token_program, decimals, symbol, requested_amount, received_amount,
      status, message, transaction, last_valid_block_height, signature, signed_transaction, confirmed_at, refund_after)
    values($1,4301,$2,$3,$4,$5,6,'USDC',6000000,6000000,'confirmed','m','t',1,$6,'s',now(),now() + interval '90 days')`,
  [crypto.randomUUID(), Keypair.generate().publicKey.toBase58(), signer.publicKey.toBase58(), USDC.mint, USDC.program, bs58.encode(Buffer.alloc(64, 7))])
  const [owed] = await tipLiabilities(p, signer.publicKey.toBase58())
  assert.deepEqual([owed.amount, owed.tips, owed.pledges], ['26000000', 1, 1])
  // The wallet only holds the pledge's 20 USDC (the tip's 6 USDC never arrived): short, and the tip payout is refused.
  const coverage = (await tipWalletCoverage(p, connection, signer.publicKey.toBase58())).find(c => c.mint === USDC.mint)
  assert.deepEqual([coverage.liability, coverage.balance, coverage.short, coverage.pledges], ['26000000', '20000000', true, 1])
  const [result] = await createTipPayouts({ pool: p, connection, signer, log: silent, landing: LANDING }).payout({ githubRepoId: '4301', review, verifyAuthority: admin(4301) })
  assert.equal(result.status, 'failed'); assert.match(result.error, /below confirmed tips/)
  assert.equal(connection.sent.length, 0)
})

dbTest('parts transfer recovery: lost broadcast stays reserved, rebroadcasts the stored bytes, aborts on provable expiry, then resends and settles', async () => {
  const p = await resetDb(), mp = marketPool(p)
  const signer = Keypair.generate(), donor = Keypair.generate().publicKey
  const connection = fakeChain({ lamports: { [signer.publicKey.toBase58()]: OPERATING }, mints: { [USDC.mint]: splMint() } })
  await bindPayout(p, 4301, Keypair.generate().publicKey)
  const { id: fundId } = await createFund({ pool: mp, githubRepoId: '4301', input: list(), verifyAuthority: admin(4301) })
  const pledgeId = await confirmedPledge(p, connection, { fundId, amount: 9_000_000n, usdCents: 900, tipWallet: signer.publicKey, donor })
  await cancelFund({ pool: p, fundId, githubRepoId: '4301', verifyAuthority: admin(4301) })
  connection.setMode('drop')
  const [pending] = await sendFundTransfers({ pool: p, connection, signer, log: silent })
  assert.equal(pending.status, 'pending')
  assert.equal((await loadPledge(p, pledgeId)).transferId, pending.id)
  assert.deepEqual(await sendFundTransfers({ pool: p, connection, signer, log: silent }), []) // reserved: never sent twice
  assert.deepEqual(await finalizeFunds({ pool: p }), []) // pending transfer: not settled
  const recovery = createTipTransferRecovery({ pool: p, connection })
  const before = connection.sent.length
  assert.deepEqual((await recovery.runOnce()).map(r => [r.ledger, r.status]), [['parts', 'pending']])
  assert.equal(connection.sent.at(-1), pending.signature); assert.equal(connection.sent.length, before + 1)
  connection.advance(500)
  assert.deepEqual((await recovery.runOnce()).map(r => r.status), ['aborted'])
  const released = await loadPledge(p, pledgeId)
  assert.deepEqual([released.status, released.transferId], ['confirmed', null])
  connection.setMode('land')
  const [second] = await sendFundTransfers({ pool: p, connection, signer, log: silent })
  assert.equal(second.status, 'settled')
  // Recovery of an already-landed intent settles it from the finalized receipt; a receipt that differs is never settled.
  await p.query(`update parts_transfers set status='pending', settled_at=null, receipt=null where id=$1`, [second.id])
  await p.query(`update parts_pledges set status='confirmed', resolved_at=null where transfer_id=$1`, [second.id])
  assert.deepEqual((await recovery.runOnce()).map(r => r.status), ['settled'])
  assert.equal((await loadPledge(p, pledgeId)).status, 'refunded')
  const { rows: [row] } = await p.query(`select amount::text, signed_transaction as "signedTransaction", signature, source_wallet as "sourceWallet", recipient, mint,
    token_program as "tokenProgram" from parts_transfers where id=$1`, [second.id])
  assert.throws(() => verifyTransferReceipt(connection.receipts.get(second.signature), { ...row, amount: '9000001' }), /delta mismatch/)
  assert.deepEqual((await finalizeFunds({ pool: p })).map(r => r.status), ['cancelled'])
})
