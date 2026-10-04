import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import BN from 'bn.js'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CP_AMM_PROGRAM_ID, CpAmm, CpAmmIdl } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient, DynamicBondingCurveIdl } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import * as accumulatorRoute from '../app/api/operations/stock-accumulator/route.js'
import { listPlatformFees } from '../src/platform-fee-operations.mjs'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { decimalText, describeAccumulator, stockAmountView, summarizeAccumulator } from '../src/stock-accumulator.mjs'
import { DBC_PROGRAM, STOCK_FEE_CUSTODY, checkStockCollectionReceipt, collectionInstructions, collectionLedger, evaluateCollection,
  stockCollectionTerms, stockCollectionTermsHash, tokenDeltas } from '../src/stock-collections.mjs'
import { STOCK_POOL_OWNERS } from '../src/stock-canonical-pools.mjs'
import { assertWritable } from '../scripts/stock-cli.mjs'
import { SETTLEMENT_LIMITS, analyzeSettlementTransaction as analyzeWithOwners, largestWithinImpact, lockCoverage, minimumAfterSlippage,
  priceImpactBps } from '../src/stock-settlement.mjs'

// Pure parts of the stock accumulator, collection previews and settlement receipts (docs/STOCK_QUOTES.md, "Accumulator and
// settlement"). Receipts are checked against synthetic finalized transactions in the shape src/finalized-transaction.mjs
// returns, with program events encoded by the programs' own IDL coders. tests/stock-accumulator-db.test.mjs covers the
// ledgers on PostgreSQL and tests/stock-accumulator-chain.test.mjs real transactions on mainnet's programs.
const META = quoteAssetById('meta-xstock')
const pk = () => Keypair.generate().publicKey
const offline = new Connection('http://127.0.0.1:1', 'finalized')
const programs = { dbc: new DynamicBondingCurveClient(offline, 'finalized').state.getProgram(), amm: new CpAmm(offline) }
const EVENT_CPI = Buffer.from('e445a52e51cb9a1d', 'hex')
const event = (idl, coder, name, data) => Buffer.concat([EVENT_CPI, Buffer.from(idl.events.find(e => e.name === name).discriminator),
  coder.types.encode(name[0].toLowerCase() + name.slice(1), data)])
const dbcEvent = (name, data) => event(DynamicBondingCurveIdl, programs.dbc.coder, name, data)
const ammEvent = (name, data) => event(CpAmmIdl, programs.amm._program.coder, name, data)
const signature = () => bs58.encode(randomBytes(64))

// A finalized transaction as src/finalized-transaction.mjs normalizes it. instructions: [{ program, accounts, data }] with
// PublicKeys; inner: [{ index, program, data }] (event CPIs); balances: [{ account, mint, owner, pre, post }] (raw, null = absent).
function transaction({ payer, instructions = [], inner = [], balances = [], err = null, fee = 5000 }) {
  const keys = [payer], index = k => { const i = keys.findIndex(x => x.equals(k)); return i >= 0 ? i : keys.push(k) - 1 }
  const compiled = instructions.map(ix => ({ programIdIndex: index(ix.program), accounts: ix.accounts.map(index), data: bs58.encode(ix.data ?? Buffer.alloc(8)) }))
  const groups = new Map()
  for (const ix of inner) groups.set(ix.index, [...(groups.get(ix.index) ?? []), { programIdIndex: index(ix.program), accounts: [], data: bs58.encode(ix.data), stackHeight: 2 }])
  const side = key => balances.filter(b => b[key] != null).map(b => ({ accountIndex: index(b.account), mint: b.mint, owner: b.owner,
    programId: TOKEN_2022_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: String(b[key]) } }))
  const sig = signature()
  return { slot: 77, blockTime: 1_790_000_000, transaction: { signatures: [sig], message: { accountKeys: keys, instructions: compiled } },
    meta: { err, fee, innerInstructions: [...groups].map(([i, list]) => ({ index: i, instructions: list })), preTokenBalances: side('pre'), postTokenBalances: side('post') } }
}

test('amounts read as raw units, as wallets show them (multiplier, truncated) and in USD', () => {
  assert.equal(decimalText(123456789n, 8), '1.23456789')
  assert.equal(decimalText(100000000n, 8), '1')
  assert.equal(decimalText(-5n, 2), '-0.05')
  assert.deepEqual(stockAmountView('100000000', META, { multiplier: '1.0028515433272898', usdPrice: 712.5 }), { raw: '100000000', shown: '1.00285154', usd: '712.50' })
  assert.deepEqual(stockAmountView(7n, META), { raw: '7', shown: null, usd: null })
  assert.throws(() => stockAmountView(1n, META, { multiplier: '-1' }), /Invalid display multiplier/)
})

const ledger = (over = {}) => ({
  markets: [{ repoId: '94911145', fullName: 'facebook/docusaurus', mint: 'MintA', pool: 'PoolA', quoteMint: META.mint, indexed: true },
    { repoId: '10270250', fullName: 'facebook/react', mint: 'MintB', pool: 'PoolB', quoteMint: META.mint, indexed: true }],
  fees: [{ repoId: '94911145', creator: '710', partner: '290', launcher: '214', accumulator: '786' },
    { repoId: '10270250', creator: '71', partner: '29', launcher: '21', accumulator: '79' }],
  checkpoints: [{ repoId: '94911145', side: 'creator', credit: '497', launcher: '150', accumulator: '347' },
    { repoId: '94911145', side: 'partner', credit: '100', launcher: '0', accumulator: '100' }],
  collections: [{ repoId: '94911145', source: 'dbc_creator', status: 'settled', count: 1, reviewed: '710', actual: '710', launcher: '214', accumulator: '496' },
    { repoId: '94911145', source: 'dbc_partner', status: 'pending', count: 1, reviewed: '290', actual: '0', launcher: '0', accumulator: '290' }],
  payouts: [{ repoId: '94911145', status: 'settled', count: 1, amount: '200' }],
  receipts: [{ kind: 'swap', count: 1, quoteSpent: '200', repoingSpent: '0', repoingReceived: '9000' },
    { kind: 'add_liquidity', count: 1, quoteSpent: '100', repoingSpent: '8000', repoingReceived: '0' }],
  receiptMints: [{ quoteMint: META.mint }], pools: [{ id: '1', pool: 'CanonicalPool', quoteMint: META.mint, repoingMint: 'Repoing', position: 'Position' }],
  ...over })

test('the accumulator adds credits, collections, payouts and receipts per stock, and reconciles with the pools', () => {
  const onchain = new Map([['94911145', { uncollected: String(1000n + 597n - 710n) }], ['10270250', { uncollected: '99' }]])
  const summary = summarizeAccumulator(META, ledger(), { onchain, units: { multiplier: '1', usdPrice: 100 } })
  assert.deepEqual(summary.totals, { credited: String(786 + 79 + 347 + 100), inPools: String(786 + 79 + 347 + 100 - 496), collected: '496', spent: '300',
    available: '196', launcherCredited: String(214 + 21 + 150), launcherInPools: String(214 + 21 + 150 - 214), collectedLauncher: '214',
    launcherPaid: '200', owedToLaunchers: String(214 + 21 + 150 - 200), custodyExpected: String(496 + 214 - 200 - 300), onchainUncollected: '986' })
  assert.equal(summary.status, 'MISMATCH')
  assert.deepEqual(summary.problems, ['Market 10270250: its pools hold 99 uncollected, the ledger expects 100'])
  assert.equal(summary.repositories.find(r => r.repoId === '94911145').onchain.status, 'MATCH')
  assert.deepEqual([summary.contributing, summary.pending.collections, summary.receipts.swap.repoingReceived, summary.repoing.spent], [2, 1, '9000', '8000'])
  assert.equal(summary.canonicalPool.pool, 'CanonicalPool')
  assert.deepEqual(summary.display.available, { raw: '196', shown: '0.00000196', usd: '0.00' })
  assert.match(describeAccumulator(summary).join('\n'), /available to settle: 0\.00000196 METAx/)
  const matched = summarizeAccumulator(META, ledger(), { onchain: new Map([['94911145', { uncollected: '887' }], ['10270250', { uncollected: '100' }]]) })
  assert.equal(matched.status, 'MATCH', matched.problems.join('; '))
})

test('the accumulator reports overspending, payouts ahead of collection, foreign mints and unreadable pools', () => {
  const summary = summarizeAccumulator(META, ledger({
    receipts: [{ kind: 'seed', count: 1, quoteSpent: '497', repoingSpent: '1', repoingReceived: '0' }],
    payouts: [{ repoId: '10270250', status: 'settled', count: 1, amount: '5' }],
    receiptMints: [{ quoteMint: META.mint }, { quoteMint: 'OtherMint' }],
    markets: [...ledger().markets, { repoId: '41881900', fullName: 'microsoft/vscode', quoteMint: 'WrongMint', indexed: true }],
    fees: [...ledger().fees, { repoId: '999', creator: '1', partner: '0', launcher: '0', accumulator: '1' }] }),
  { onchain: new Map([['94911145', { error: 'RPC down' }]]) })
  assert.equal(summary.totals.available, '-1')
  for (const pattern of [/spend 497 but only 496/, /Market 10270250: launcher paid before/, /names mint OtherMint/, /stamped with mint WrongMint/,
    /Ledger rows for market 999/, /Market 94911145: pools unreadable \(RPC down\)/]) assert.ok(summary.problems.some(p => pattern.test(p)), String(pattern))
})

test('the accumulator compares custody with the ledger and refuses to count one signature twice', () => {
  const onchain = new Map([['94911145', { uncollected: '887' }], ['10270250', { uncollected: '100' }]])
  const expected = 496n + 214n - 200n - 300n
  const held = summarizeAccumulator(META, ledger(), { onchain, custodyBalance: expected + 5n })
  assert.deepEqual([held.status, held.totals.custodyBalance, held.totals.custodyExpected], ['MATCH', String(expected + 5n), String(expected)], 'extra funds are not a problem')
  const short = summarizeAccumulator(META, ledger(), { onchain, custodyBalance: expected - 1n })
  assert.deepEqual(short.problems, [`Custody holds ${expected - 1n}, less than the ${expected} the ledger expects there: funds left custody that no settlement receipt or launcher payout records`])
  const twice = summarizeAccumulator(META, ledger({ repeated: [{ kind: 'collection', signature: 'SameSig' }] }), { onchain })
  assert.deepEqual(twice.problems, ['Signature SameSig settles more than one collection'])
})

const sources = (over = {}) => collectionLedger({
  fees: { creator: '710', partner: '290', launcher: '214' },
  checkpoints: [{ side: 'creator', count: 2, credit: '497', launcher: '150', earned: '497', claimed: '0', position: 'CreatorPos', pool: 'Damm', slot: '9' }],
  collections: [{ source: 'dbc_creator', status: 'settled', count: 1, actual: '600', launcher: '180', accumulator: '420' },
    { source: 'dbc_partner', status: 'pending', count: 1, actual: '0', launcher: '0', accumulator: '0' }], ...over })

test('a collection is planned only when the pool and the ledger agree exactly, with the launcher and accumulator parts', () => {
  const l = sources()
  assert.deepEqual(evaluateCollection('dbc_creator', l.dbc_creator, { uncollected: 110n }), { source: 'dbc_creator', onchain: '110', ledgerExpected: '110',
    earned: '710', collected: '600', launcherEarned: '214', launcherCollected: '180', status: 'MATCH', amount: '110', launcherAmount: '34', accumulatorAmount: '76' })
  assert.match(evaluateCollection('dbc_creator', l.dbc_creator, { uncollected: 111n }).reason, /indexing must catch up/)
  assert.match(evaluateCollection('dbc_creator', l.dbc_creator, { uncollected: 109n }).reason, /less than the ledger expects/)
  assert.equal(evaluateCollection('dbc_partner', l.dbc_partner, { uncollected: 290n }).status, 'PENDING')
  assert.equal(evaluateCollection('dbc_creator', sources({ fees: { creator: '0', partner: '0', launcher: '0' }, collections: [] }).dbc_creator, { uncollected: 0n }).status, 'EMPTY')
  const damm = evaluateCollection('damm_creator', l.damm_creator, { uncollected: 497n, claimed: 0n, pool: 'Damm', position: 'CreatorPos' })
  assert.deepEqual([damm.status, damm.amount, damm.launcherAmount, damm.accumulatorAmount], ['MATCH', '497', '150', '347'])
  // Checkpoints of another pool or position than the graduation recorded never plan a collection.
  for (const elsewhere of [{ pool: 'OtherDamm', position: 'CreatorPos' }, { pool: 'Damm', position: 'OtherPos' }])
    assert.match(evaluateCollection('damm_creator', l.damm_creator, { uncollected: 497n, claimed: 0n, ...elsewhere }).reason, /another pool or position/)
  assert.match(evaluateCollection('damm_creator', l.damm_creator, { uncollected: 498n, claimed: 0n }).reason, /earned more than the last checkpoint/)
  assert.match(evaluateCollection('damm_creator', l.damm_creator, { uncollected: 400n, claimed: 97n }).reason, /claimed from this position outside the collection ledger/)
  assert.match(evaluateCollection('damm_partner', l.damm_partner, { uncollected: 5n, claimed: 0n }).reason, /no checkpoint/)
  assert.equal(evaluateCollection('damm_partner', l.damm_partner, { uncollected: 0n, claimed: 0n }).status, 'EMPTY')
  assert.match(evaluateCollection('damm_creator', sources({ checkpoints: [{ side: 'creator', count: 1, credit: '497', launcher: '150', earned: '496', claimed: '0' }] })
    .damm_creator, { uncollected: 497n, claimed: 0n }).reason, /do not add up/)
  // A launcher share larger than what the pool holds is never planned.
  assert.equal(evaluateCollection('dbc_creator', sources({ fees: { creator: '710', partner: '0', launcher: '700' } }).dbc_creator, { uncollected: 110n }).status, 'MISMATCH')
})

const market = { repoId: '94911145', mint: pk().toBase58(), pool: pk().toBase58(), creatorWallet: pk().toBase58() }
const dbcState = { config: pk().toBase58(), baseVault: pk().toBase58(), quoteVault: pk().toBase58() }

async function planned(source = 'dbc_creator', amount = '110', extra = {}) {
  const signer = source === 'dbc_creator' ? market.creatorWallet : STOCK_FEE_CUSTODY
  const built = await collectionInstructions({ source, signer, custody: STOCK_FEE_CUSTODY, market, quoteMint: META.mint, amount, dbc: dbcState, programs, ...extra })
  const evaluation = { status: 'MATCH', amount, launcherAmount: '34', accumulatorAmount: String(BigInt(amount) - 34n), earned: '710', collected: '600', launcherEarned: '214', launcherCollected: '180' }
  const terms = stockCollectionTerms({ market, asset: META, source, evaluation, signer, custody: STOCK_FEE_CUSTODY, built, sourceVault: dbcState.quoteVault,
    pool: market.pool, config: source === 'dbc_partner' ? dbcState.config : null })
  return { built, terms, signer }
}

test('the previewed instructions are exact and offline, and the terms hash pins every account and amount', async () => {
  const { built, terms } = await planned()
  assert.deepEqual(built.instructions.map(ix => [ix.program, ix.name]), [[ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'createIdempotent'],
    [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'createIdempotent'], [DBC_PROGRAM.toBase58(), 'claim_creator_trading_fee']])
  const claim = built.instructions[2]
  assert.equal(Buffer.from(claim.data, 'base64').toString('hex'), '52dcfabd03556b2d' + '0000000000000000' + '6e00000000000000', 'max base 0, max quote 110')
  const byName = Object.fromEntries(claim.accounts.map(a => [a.name, a]))
  assert.deepEqual([byName.pool.address, byName.creator.address, byName.creator.signer, byName.tokenBAccount.address, byName.quoteMint.address,
    byName.tokenQuoteProgram.address], [market.pool, market.creatorWallet, true, built.receiverTokenAccount, META.mint, TOKEN_2022_PROGRAM_ID.toBase58()])
  assert.match(stockCollectionTermsHash(terms), /^[0-9a-f]{64}$/)
  assert.equal(stockCollectionTermsHash(terms), stockCollectionTermsHash((await planned()).terms), 'the same state gives the same hash')
  assert.notEqual(stockCollectionTermsHash(terms), stockCollectionTermsHash((await planned('dbc_creator', '111')).terms))
  const partner = await planned('dbc_partner')
  assert.equal(partner.built.instructions[2].name, 'claim_trading_fee')
  assert.equal(partner.terms.config, dbcState.config)
})

// The finalized claim transaction a collection's execution would produce, with the given amounts and balance moves.
function claimTransaction({ terms, claimed = BigInt(terms.amount), base = 0n, receiverDelta = claimed, vaultDelta = -claimed, extra = [], payer = terms.signer,
  programsRun = [], eventPool = terms.pool, source = terms.source }) {
  const name = source === 'dbc_creator' ? 'EvtClaimCreatorTradingFee' : 'EvtClaimTradingFee'
  const layout = source === 'dbc_creator' ? { pool: 1, receiver: 3, vault: 5, signer: 8, size: 13 } : { pool: 2, receiver: 4, vault: 6, signer: 9, size: 14 }
  const accounts = Array.from({ length: layout.size }, () => pk())
  accounts[layout.pool] = new PublicKey(terms.pool); accounts[layout.receiver] = new PublicKey(terms.receiverTokenAccount)
  accounts[layout.vault] = new PublicKey(terms.sourceVault); accounts[layout.signer] = new PublicKey(terms.signer)
  const discriminator = Buffer.from(source === 'dbc_creator' ? '52dcfabd03556b2d' : '08ec5931987db151', 'hex')
  return transaction({ payer: new PublicKey(payer), instructions: [
    { program: ComputeBudgetProgram.programId, accounts: [] },
    { program: ASSOCIATED_TOKEN_PROGRAM_ID, accounts: [] },
    { program: DBC_PROGRAM, accounts, data: Buffer.concat([discriminator, Buffer.alloc(16)]) }, ...programsRun],
  inner: [{ index: 2, program: DBC_PROGRAM, data: dbcEvent(name, { pool: new PublicKey(eventPool), tokenBaseAmount: new BN(String(base)), tokenQuoteAmount: new BN(String(claimed)) }) }],
  balances: [{ account: new PublicKey(terms.receiverTokenAccount), mint: META.mint, owner: STOCK_FEE_CUSTODY, pre: 5, post: 5n + receiverDelta },
    { account: new PublicKey(terms.sourceVault), mint: META.mint, owner: 'pool', pre: 1000, post: 1000n + vaultDelta }, ...extra] })
}

test('a collection receipt must match its review: signer, programs, accounts, claim event and exact Token-2022 deltas', async () => {
  const { terms } = await planned()
  const receipt = checkStockCollectionReceipt({ transaction: claimTransaction({ terms }), terms })
  assert.deepEqual([receipt.amount, receipt.excess, receipt.receiver, receipt.networkFee], ['110', '0', STOCK_FEE_CUSTODY, '5000'])
  const refused = (over, pattern, t = terms) => assert.throws(() => checkStockCollectionReceipt({ transaction: claimTransaction({ terms: t, ...over }), terms: t }), pattern)
  refused({ claimed: 109n }, /differs from the reviewed amount/)
  refused({ receiverDelta: 109n }, /Exact .* balance delta mismatch/)
  refused({ vaultDelta: -111n }, /Exact .* balance delta mismatch/)
  refused({ extra: [{ account: pk(), mint: META.mint, owner: 'someone', pre: 1, post: 2 }] }, /Exact .* balance delta mismatch/)
  refused({ payer: pk().toBase58() }, /not paid for by its reviewed signer/)
  refused({ programsRun: [{ program: SystemProgram.programId, accounts: [] }] }, /Unexpected program/)
  refused({ eventPool: pk().toBase58() }, /exactly one claim event/)
  refused({ base: 1n }, /moved market tokens/)
  const partner = (await planned('dbc_partner')).terms
  assert.equal(checkStockCollectionReceipt({ transaction: claimTransaction({ terms: partner }), terms: partner }).amount, '110')
  // A creator-fee claim is not accepted as the partner's, nor the other way round.
  assert.throws(() => checkStockCollectionReceipt({ transaction: claimTransaction({ terms: partner, source: 'dbc_creator' }), terms: partner }), /Unexpected instruction|other accounts/)
  const failed = claimTransaction({ terms }); failed.meta.err = { InstructionError: [2, 'Custom'] }
  assert.throws(() => checkStockCollectionReceipt({ transaction: failed, terms }), /failed on chain/)
  assert.throws(() => checkStockCollectionReceipt({ transaction: null, terms }), /not available yet/)
})

test('token deltas count created and closed accounts from and to zero', () => {
  const account = pk(), closed = pk()
  const tx = transaction({ payer: pk(), balances: [{ account, mint: META.mint, owner: 'o', pre: null, post: 7 }, { account: closed, mint: META.mint, owner: 'o', pre: 3, post: null }] })
  const deltas = tokenDeltas(tx, META.mint)
  assert.deepEqual([deltas.get(account.toBase58()).delta, deltas.get(closed.toBase58()).delta], [7n, -3n])
})

// The canonical REPOING/METAx pool row as stock_canonical_pools holds it (REPOING token A, METAx token B).
const owner = new PublicKey(STOCK_POOL_OWNERS[0])
const canonical = { id: '1', pool: pk().toBase58(), repoingMint: pk().toBase58(),
  evidence: { pool: { sides: { repoing: 'A', stock: 'B' }, tokenAVault: pk().toBase58(), tokenBVault: pk().toBase58() } } }
const analyzeSettlementTransaction = args => analyzeWithOwners({ owners: STOCK_POOL_OWNERS, ...args })
const zero = () => new BN(0), n = value => new BN(String(value))
const swapEvent = ({ pool = canonical.pool, direction = 1, amountIn = 1000n, amountOut = 40000n } = {}) => ammEvent('EvtSwap2', { pool: new PublicKey(pool),
  tradeDirection: direction, collectFeeMode: 1, hasReferral: false, params: { amount0: n(amountIn), amount1: n(1), swapMode: 0 },
  swapResult: { includedFeeInputAmount: n(amountIn), excludedFeeInputAmount: n(amountIn), amountLeft: zero(), outputAmount: n(amountOut), nextSqrtPrice: n(1),
    claimingFee: zero(), protocolFee: zero(), compoundingFee: zero(), referralFee: zero() },
  includedTransferFeeAmountIn: n(amountIn), includedTransferFeeAmountOut: n(amountOut), excludedTransferFeeAmountOut: n(amountOut),
  currentTimestamp: n(1), reserveAAmount: zero(), reserveBAmount: zero() })
const depositEvent = ({ position, a = 39000n, b = 1000n, changeType = 0, who = owner } = {}) => ammEvent('EvtLiquidityChange', { pool: new PublicKey(canonical.pool),
  position, owner: who, tokenAAmount: n(a), tokenBAmount: n(b), transferFeeIncludedTokenAAmount: n(a), transferFeeIncludedTokenBAmount: n(b),
  reserveAAmount: zero(), reserveBAmount: zero(), liquidityDelta: n(5), tokenAAmountThreshold: n(a), tokenBAmountThreshold: n(b), changeType })

function settlementTransaction({ events, stock = [], repoing = [], payer = owner, extraPrograms = [] }) {
  const ownerStock = pk(), ownerRepoing = pk()
  return transaction({ payer, instructions: [{ program: ComputeBudgetProgram.programId, accounts: [] }, { program: CP_AMM_PROGRAM_ID, accounts: [] }, ...extraPrograms],
    inner: events.map(data => ({ index: 1, program: CP_AMM_PROGRAM_ID, data })),
    balances: [...stock.map(([who, pre, post]) => ({ account: who === 'vault' ? new PublicKey(canonical.evidence.pool.tokenBVault) : who === 'owner' ? ownerStock : pk(),
      mint: META.mint, owner: who === 'owner' ? owner.toBase58() : 'other', pre, post })),
    ...repoing.map(([who, pre, post]) => ({ account: who === 'vault' ? new PublicKey(canonical.evidence.pool.tokenAVault) : who === 'owner' ? ownerRepoing : pk(),
      mint: canonical.repoingMint, owner: who === 'owner' ? owner.toBase58() : 'other', pre, post }))] })
}

test('a settlement swap receipt: one stock → REPOING swap on the canonical pool by an owner wallet, exact deltas', () => {
  const tx = settlementTransaction({ events: [swapEvent()], stock: [['owner', 5000, 4000], ['vault', 100, 1100]], repoing: [['owner', 0, 40000], ['vault', 90000, 50000]] })
  const found = analyzeSettlementTransaction({ transaction: tx, kind: 'swap', asset: META, canonical })
  assert.deepEqual([found.quoteSpent, found.repoingSpent, found.repoingReceived, found.owner, found.deltas.stock.owner, found.deltas.repoing.vault],
    [1000n, 0n, 40000n, owner.toBase58(), '-1000', '-40000'])
  const refused = (args, pattern) => assert.throws(() => analyzeSettlementTransaction({ asset: META, canonical, kind: 'swap', ...args }), pattern)
  refused({ transaction: settlementTransaction({ events: [swapEvent({ direction: 0 })], stock: [['owner', 5000, 4000], ['vault', 100, 1100]] }) }, /sells REPOING/)
  refused({ transaction: settlementTransaction({ events: [swapEvent({ pool: pk().toBase58() })] }) }, /another DAMM v2 pool/)
  refused({ transaction: settlementTransaction({ events: [swapEvent()], payer: pk() }) }, /not an owner wallet/)
  refused({ transaction: settlementTransaction({ events: [swapEvent()], extraPrograms: [{ program: pk(), accounts: [] }] }) }, /also runs/)
  refused({ transaction: settlementTransaction({ events: [swapEvent(), swapEvent()] }) }, /exactly one swap/)
  refused({ transaction: settlementTransaction({ events: [swapEvent()], stock: [['owner', 5000, 3999], ['vault', 100, 1100]], repoing: [['owner', 0, 40000], ['vault', 90000, 50000]] }) }, /owner's METAx balance moved -1001/)
  refused({ transaction: settlementTransaction({ events: [swapEvent()], stock: [['owner', 5000, 4000], ['vault', 100, 1100], ['someone', 1, 2]], repoing: [['owner', 0, 40000], ['vault', 90000, 50000]] }) }, /Another METAx account moved/)
  refused({ transaction: settlementTransaction({ events: [swapEvent()], stock: [['owner', 5000, 4000], ['vault', 100, 1100]], repoing: [['owner', 0, 40001], ['vault', 90000, 50000]] }) }, /REPOING balance moved 40001/)
  refused({ transaction: settlementTransaction({ events: [swapEvent()] }), kind: 'mint' }, /kind must be one of/)
  const failed = settlementTransaction({ events: [swapEvent()] }); failed.meta.err = { InstructionError: [1, 'Custom'] }
  refused({ transaction: failed }, /failed on chain/)
})

test('an add-liquidity receipt counts a balancing swap and the deposit; it names the positions to check for a permanent lock', () => {
  const position = pk()
  const tx = settlementTransaction({ events: [swapEvent(), depositEvent({ position })],
    stock: [['owner', 5000, 3000], ['vault', 100, 2100]], repoing: [['owner', 0, 1000], ['vault', 90000, 89000]] })
  const found = analyzeSettlementTransaction({ transaction: tx, kind: 'add_liquidity', asset: META, canonical })
  assert.deepEqual([found.quoteSpent, found.repoingSpent, found.repoingReceived, found.positions], [2000n, 39000n, 40000n, [position.toBase58()]])
  assert.deepEqual(found.liquidity, { [position.toBase58()]: '5' }, 'the liquidity this deposit added, for the permanent-lock check')
  assert.deepEqual(found.deposit, { stock: '1000', repoing: '39000' })
  assert.throws(() => analyzeSettlementTransaction({ transaction: tx, kind: 'swap', asset: META, canonical }), /exactly one swap/)
  assert.throws(() => analyzeSettlementTransaction({ kind: 'add_liquidity', asset: META, canonical,
    transaction: settlementTransaction({ events: [depositEvent({ position, changeType: 1 })] }) }), /not an owner wallet adding liquidity/)
  assert.throws(() => analyzeSettlementTransaction({ kind: 'add_liquidity', asset: META, canonical,
    transaction: settlementTransaction({ events: [depositEvent({ position, who: pk() })] }) }), /not an owner wallet adding liquidity/)
  assert.throws(() => analyzeSettlementTransaction({ kind: 'seed', asset: META, canonical, transaction: tx }), /exactly one pool creation/)
})

test('settlement planning helpers: exact price impact and the largest size within the bound', () => {
  const q64 = 1n << 64n
  assert.equal(priceImpactBps(q64, q64), 0n)
  assert.equal(priceImpactBps(q64, q64 * 101n / 100n), 201n, 'a 1% higher sqrt price is a 2.01% higher price (201 bps, rounded up)')
  assert.equal(priceImpactBps(q64 * 2n, q64), 7500n)
  // impact grows with size: 1 bps per 100 raw units swapped.
  const impact = half => half / 100n
  assert.equal(largestWithinImpact(1_000_000n, impact, 300), 60_199n)
  assert.equal(largestWithinImpact(10_000n, impact, 300), 10_000n)
  assert.equal(largestWithinImpact(10_000n, () => 301n, 300), null)
  assert.equal(largestWithinImpact(10_000n, half => { if (half > 2500n) throw Error('not enough liquidity'); return 0n }, 300), 5001n, 'a size the pool cannot quote does not fit')
  assert.deepEqual(SETTLEMENT_LIMITS, { slippageBps: 500, priceImpactBps: 1000 })
})

test('a graduated position\'s collection receipt takes everything accrued: exact or more, never less, and only that position', async () => {
  const damm = { pool: pk().toBase58(), tokenAVault: pk().toBase58(), tokenBVault: pk().toBase58(),
    creator: { position: pk().toBase58(), nftAccount: pk().toBase58() } }
  const signer = market.creatorWallet
  const built = await collectionInstructions({ source: 'damm_creator', signer, custody: STOCK_FEE_CUSTODY, market, quoteMint: META.mint, amount: '400', damm, programs })
  assert.equal(built.instructions[2].name, 'claim_position_fee')
  const evaluation = { status: 'MATCH', amount: '400', launcherAmount: '120', accumulatorAmount: '280', earned: '400', collected: '0', launcherEarned: '120', launcherCollected: '0' }
  const terms = stockCollectionTerms({ market, asset: META, source: 'damm_creator', evaluation, signer, custody: STOCK_FEE_CUSTODY, built,
    sourceVault: damm.tokenBVault, pool: damm.pool, position: damm.creator.position })
  const claim = ({ claimed, position = terms.position }) => {
    const accounts = Array.from({ length: 15 }, () => pk())
    accounts[1] = new PublicKey(terms.pool); accounts[2] = new PublicKey(terms.position); accounts[4] = new PublicKey(terms.receiverTokenAccount)
    accounts[6] = new PublicKey(terms.sourceVault); accounts[10] = new PublicKey(signer)
    return transaction({ payer: new PublicKey(signer), instructions: [{ program: CP_AMM_PROGRAM_ID, accounts, data: Buffer.concat([Buffer.from('b4269a118521a2d3', 'hex')]) }],
      inner: [{ index: 0, program: CP_AMM_PROGRAM_ID, data: ammEvent('EvtClaimPositionFee', { pool: new PublicKey(terms.pool), position: new PublicKey(position),
        owner: new PublicKey(signer), feeAClaimed: zero(), feeBClaimed: n(claimed) }) }],
      balances: [{ account: new PublicKey(terms.receiverTokenAccount), mint: META.mint, owner: STOCK_FEE_CUSTODY, pre: 0, post: claimed },
        { account: new PublicKey(terms.sourceVault), mint: META.mint, owner: 'pool', pre: 10_000, post: 10_000n - BigInt(claimed) }] })
  }
  assert.deepEqual(Object.entries(checkStockCollectionReceipt({ transaction: claim({ claimed: 400n }), terms })).filter(([k]) => ['amount', 'excess'].includes(k)),
    [['amount', '400'], ['excess', '0']])
  assert.equal(checkStockCollectionReceipt({ transaction: claim({ claimed: 412n }), terms }).excess, '12', 'fees accrued since the review are reported')
  assert.throws(() => checkStockCollectionReceipt({ transaction: claim({ claimed: 399n }), terms }), /differs from the reviewed amount/)
  assert.throws(() => checkStockCollectionReceipt({ transaction: claim({ claimed: 400n, position: pk().toBase58() }), terms }), /exactly one claim event/)
})

const initEvent = ({ creator = owner, payer = owner, a = 39000n, b = 1000n, liquidity = 77n } = {}) => ammEvent('EvtInitializePool', {
  pool: new PublicKey(canonical.pool), tokenAMint: new PublicKey(canonical.repoingMint), tokenBMint: new PublicKey(META.mint), creator, payer,
  alphaVault: PublicKey.default, poolFees: { baseFee: { data: Array(27).fill(0) }, compoundingFeeBps: 0, padding: 0, dynamicFee: null },
  sqrtMinPrice: n(1), sqrtMaxPrice: n(2), activationType: 0, collectFeeMode: 1, liquidity: n(liquidity), sqrtPrice: n(1), activationPoint: zero(),
  tokenAFlag: 0, tokenBFlag: 1, tokenAAmount: n(a), tokenBAmount: n(b), totalAmountA: n(a), totalAmountB: n(b), poolType: 0 })
const createdEvent = position => ammEvent('EvtCreatePosition', { pool: new PublicKey(canonical.pool), owner, position, positionNftMint: pk() })

test('a seed receipt is the pool\'s creation, signed and paid for by owner wallets, with its one position\'s liquidity', () => {
  const position = pk()
  const seed = (events, payer = owner) => settlementTransaction({ events, payer, stock: [['owner', 5000, 4000], ['vault', null, 1000]],
    repoing: [['owner', 90000, 51000], ['vault', null, 39000]] })
  const found = analyzeSettlementTransaction({ transaction: seed([initEvent(), createdEvent(position)]), kind: 'seed', asset: META, canonical })
  assert.deepEqual([found.quoteSpent, found.repoingSpent, found.repoingReceived, found.liquidity], [1000n, 39000n, 0n, { [position.toBase58()]: '77' }])
  // Anyone may name an owner wallet as the pool's creator; only an owner wallet's own signature and funds make it the owner's.
  assert.throws(() => analyzeSettlementTransaction({ transaction: seed([initEvent({ payer: pk() }), createdEvent(position)]), kind: 'seed', asset: META, canonical }),
    /not created and paid for by owner wallets/)
  assert.throws(() => analyzeSettlementTransaction({ transaction: seed([initEvent({ creator: pk() }), createdEvent(position)]), kind: 'seed', asset: META, canonical }),
    /not created and paid for by owner wallets/)
  assert.throws(() => analyzeSettlementTransaction({ transaction: seed([initEvent(), createdEvent(position)], pk()), kind: 'seed', asset: META, canonical }),
    /not an owner wallet/)
  assert.throws(() => analyzeSettlementTransaction({ transaction: seed([initEvent(), createdEvent(position), createdEvent(pk())]), kind: 'seed', asset: META, canonical }),
    /exactly one position/)
  assert.throws(() => analyzeWithOwners({ transaction: seed([initEvent(), createdEvent(position)]), kind: 'seed', asset: META, canonical }), /Owner wallets are required/)
})

test('liquidity counts only while permanently locked and covering every deposit recorded into the position', () => {
  const facts = (permanent, unlocked = '0', vested = '0') => ({ address: 'Position', fullyLocked: unlocked === '0' && vested === '0' && BigInt(permanent) > 0n,
    liquidity: { permanent, unlocked, vested } })
  assert.equal(lockCoverage(facts('100'), '60', '40'), null)
  assert.match(lockCoverage(facts('100'), '61', '40'), /100 permanently locked liquidity, less than the 101 recorded/)
  assert.match(lockCoverage(facts('100', '5'), '0', '1'), /still holds 5 unlocked and 0 vesting/)
  assert.match(lockCoverage(facts('100', '0', '3'), '0', '1'), /still holds 0 unlocked and 3 vesting/)
  assert.equal(minimumAfterSlippage(1_000_000n, 100), 990_000n, 'slippage is in basis points, floored as the SDK floors it')
  assert.equal(minimumAfterSlippage(999n, 500), 949n)
})

test('the scripts write to the database only for mainnet facts read through two agreeing RPCs', () => {
  assert.throws(() => assertWritable({ network: 'genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', verification: {} }), /mainnet transactions only/)
  assert.throws(() => assertWritable({ network: 'mainnet', verification: null }), /second RPC \(GRADUATION_VERIFICATION_RPC_URL\)/)
  assert.doesNotThrow(() => assertWritable({ network: 'mainnet', verification: {} }))
})

test('the SOL platform-fee listing never lists a stock-paired market', async () => {
  const seen = []
  const pool = { connect: async () => ({ release: () => {}, query: async sql => { seen.push(sql); return { rows: [] } } }) }
  assert.deepEqual(await listPlatformFees({ pool, feeService: () => { throw Error('no market to read') } }), [])
  assert.match(seen[0], /m\.status='confirmed' and m\.indexed_at is not null and m\.launch_finality='finalized' and m\.quote_asset_id is null/)
})

test('the stock accumulator operator route is read-only and refuses non-operators before any read', async t => {
  const previous = { secret: process.env.GITHUB_APP_CLIENT_SECRET, operators: process.env.PLATFORM_OPERATOR_GITHUB_IDS, db: process.env.DATABASE_URL }
  t.after(() => { for (const [key, value] of Object.entries({ GITHUB_APP_CLIENT_SECRET: previous.secret, PLATFORM_OPERATOR_GITHUB_IDS: previous.operators, DATABASE_URL: previous.db })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  process.env.GITHUB_APP_CLIENT_SECRET = randomBytes(32).toString('hex')
  process.env.PLATFORM_OPERATOR_GITHUB_IDS = '123'
  delete process.env.DATABASE_URL
  const session = githubUserId => encryptGithubSession({ scope: 'builders', repoId: null, permission: 'identity', githubUserId,
    accessToken: 'ghu_test_only', sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000 })
  const request = cookie => ({ url: 'https://repo.ing/api/operations/stock-accumulator', headers: new Headers({ origin: 'https://repo.ing' }),
    cookies: { get: () => (cookie ? { value: cookie } : undefined) } })
  for (const [cookie, status] of [[undefined, 401], [session('456'), 403], [session('123'), 503]]) {
    const response = await accumulatorRoute.GET(request(cookie))
    assert.equal(response.status, status)
    assert.match(response.headers.get('cache-control'), /no-store/)
  }
  assert.deepEqual(Object.keys(accumulatorRoute).filter(name => /^[A-Z]+$/.test(name)), ['GET'], 'no method that could act')
})
