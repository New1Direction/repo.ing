import bs58 from 'bs58'
import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync } from '@solana/spl-token'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'
import { quoteOfMarket } from './quote-assets.mjs'
import { POLICY_VERSION } from './stock-fee-policy.mjs'
import { checkTipMint } from './tip-tokens.mjs'
import { associatedAccountLength } from './trade-costs.mjs'
import { STOCK_FEE_CUSTODY, custodyStockBalance, listStockMarkets, tokenDeltas } from './stock-collections.mjs'
import { stockCustodyAccount } from './stock-reconcile.mjs'
import { StockLauncherBalanceError, launcherEarnings, readMarketLauncherLedger } from './stock-launcher-earnings.mjs'
import { STOCK_EXECUTION_ERRORS as E, assertExecutionNetwork, assertSignedMessage, assertSigner, assertStockExecutionEnabled, errorResult,
  fail, followLanding, isRepoId, pendingIntent, raiseExecutionAlert, recoverPendingRow, sendFirst, signStockTransaction } from './stock-execution.mjs'
import { createStockExecutionStore } from './stock-execution-store.mjs'

// Paying a stock-paired market's launcher their 0.30% (docs/STOCK_QUOTES.md, "Execution (off by default)"), behind
// STOCK_LAUNCHER_PAYOUTS_ENABLED=true and only from scripts/stock-execute.mjs --execute, which passes the Keychain signer
// (loadSigner); without one a payout is refused, so the worker can only recover. The amount is the launcher ledger's `payable`
// (src/stock-launcher-earnings.mjs: the launcher's part of fees already collected into custody, less what was paid or is
// pending), read under the market's lock, and only to the market's launcher_wallet (the database refuses any other wallet).
// Custody must hold it (custodyGate). A payout is one Token-2022 transferChecked of the stock from the stock custody account to the
// launcher's account, after creating the launcher's account idempotently, custody paying the network fee and any rent. It
// settles only from a finalized receipt with exact raw deltas (custody −amount, the launcher +amount) in which nothing else moved.

// A payout below this many raw units of the stock waits for more to accrue: 0.01 of a whole token at the xStocks' 8 decimals
// (about $1.80 to $7 at today's prices), against a network fee and, the first time, ~0.0021 SOL of rent for the launcher's stock
// account (179 bytes for METAx). An asset can carry its own floor in STOCK_LAUNCHER_PAYOUT_MIN_RAW_BY_ASSET.
export const STOCK_LAUNCHER_PAYOUT_MIN_RAW = 1_000_000n
export const STOCK_LAUNCHER_PAYOUT_MIN_RAW_BY_ASSET = Object.freeze({})
export function launcherPayoutMinimum(assetId, overrides = STOCK_LAUNCHER_PAYOUT_MIN_RAW_BY_ASSET) {
  return overrides[assetId] === undefined ? STOCK_LAUNCHER_PAYOUT_MIN_RAW : BigInt(overrides[assetId])
}

const TRANSFER_CHECKED = 12
const CREATE_IDEMPOTENT = Buffer.from([1])
const T22 = TOKEN_2022_PROGRAM_ID.toBase58(), ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
const text = value => String(value)

// Whether custody can make a payout, from its live raw balance and the stock's ledgers (store.custodyLedger). Never an equality:
// anyone can send the custody account dust, and a surplus changes nothing. The ledgers' lower bound of what custody holds is
// settled collections − settled payouts − pending payouts − recorded settlement spends; a balance below it is a shortfall, an
// ERROR that blocks every payout of the stock. Otherwise the balance must cover this payout plus every payout still pending
// (they may not have left yet); when it does not, the payout waits.
export function custodyGate({ balance, amount, ledger }) {
  const holds = ledger.collected - ledger.paid - ledger.pending - ledger.spent
  if (holds < 0n) fail(E.CUSTODY_SHORTFALL, 'The custody ledgers are inconsistent: more paid or spent than collected; payouts are blocked')
  if (balance < holds) fail(E.CUSTODY_SHORTFALL, `Custody holds ${balance} raw units of the stock, less than the ${holds} its ledgers say it holds; payouts are blocked`)
  const needed = amount + ledger.pending
  return { ok: balance >= needed, balance, holds, needed }
}

// The payout's two instructions, built offline. Custody's account is the one stock custody account (stockCustodyAccount).
export function launcherPayoutInstructions({ custody, wallet, mint, decimals, amount }) {
  const custodyKey = new PublicKey(custody), walletKey = new PublicKey(wallet), mintKey = new PublicKey(mint)
  const custodyTokenAccount = new PublicKey(stockCustodyAccount(custodyKey, mintKey))
  const walletTokenAccount = getAssociatedTokenAddressSync(mintKey, walletKey, false, TOKEN_2022_PROGRAM_ID)
  return { custodyTokenAccount: custodyTokenAccount.toBase58(), walletTokenAccount: walletTokenAccount.toBase58(), instructions: [
    createAssociatedTokenAccountIdempotentInstruction(custodyKey, walletTokenAccount, walletKey, mintKey, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(custodyTokenAccount, mintKey, walletTokenAccount, custodyKey, BigInt(amount), decimals, [], TOKEN_2022_PROGRAM_ID)] }
}

// The instructions of a finalized payout: compute budget, at most one idempotent creation of the launcher's stock account, and
// exactly one transferChecked of exactly the amount from custody's account to the launcher's. Returns the creations' indexes.
function payoutInstructions(message, keys, terms) {
  const amount = BigInt(terms.amount), creations = new Set()
  let transfers = 0
  message.instructions.forEach((ix, index) => {
    const program = keys[ix.programIdIndex], data = Buffer.from(bs58.decode(ix.data)), named = i => keys[ix.accounts[i]]
    if (program === ComputeBudgetProgram.programId.toBase58()) return
    if (program === ATA) {
      if (!data.equals(CREATE_IDEMPOTENT) || ix.accounts.length !== 6 || named(0) !== terms.custody || named(1) !== terms.walletTokenAccount ||
        named(2) !== terms.wallet || named(3) !== terms.quoteMint || named(5) !== T22) fail(E.RECEIPT, "The payout created another account than the launcher's")
      creations.add(index)
    } else if (program === T22) {
      if (data.length !== 10 || data[0] !== TRANSFER_CHECKED || ix.accounts.length !== 4 || named(0) !== terms.custodyTokenAccount ||
        named(1) !== terms.quoteMint || named(2) !== terms.walletTokenAccount || named(3) !== terms.custody ||
        data.readBigUInt64LE(1) !== amount || data[9] !== terms.decimals) fail(E.RECEIPT, 'The transfer is not the reviewed one')
      transfers++
    } else fail(E.RECEIPT, `Unexpected program ${program} in the payout`)
  })
  if (transfers !== 1 || creations.size > 1) fail(E.RECEIPT, 'A payout is exactly one transfer after at most one account creation')
  return creations
}

// A finalized payout (as src/finalized-transaction.mjs normalizes it) against its terms. Custody alone signed and paid; only the
// payout's instructions ran (payoutInstructions) and no program ran under the transfer (a transfer hook); the stock moved exactly
// custody −amount and launcher +amount, and no other token moved. SOL: the launcher's stock account may gain at most its rent
// (terms.rentCap, the rent of the account Token-2022 creates for this mint), including when someone pre-funded its address with
// lamports before it existed; custody pays exactly the network fee plus what that account gained; nothing else moved. Returns the
// receipt; throws on any difference.
export function checkLauncherPayoutReceipt({ transaction, terms, signature }) {
  if (!transaction?.meta) fail(E.RECEIPT, 'The payout receipt is not available yet')
  if (transaction.meta.err) fail(E.RECEIPT, 'The payout failed on chain')
  if (signature && transaction.transaction.signatures?.[0] !== signature) fail(E.RECEIPT, 'Receipt signature mismatch')
  const message = transaction.transaction.message
  const keys = message.accountKeys.map(k => (k instanceof PublicKey ? k.toBase58() : String(k)))
  if (keys[0] !== terms.custody || message.header?.numRequiredSignatures !== 1) fail(E.RECEIPT, 'The payout was not signed and paid for by custody alone')
  const creations = payoutInstructions(message, keys, terms)
  for (const group of transaction.meta.innerInstructions ?? []) if (!creations.has(group.index)) fail(E.RECEIPT, 'Another program ran under the transfer')
  for (const balance of [...(transaction.meta.preTokenBalances ?? []), ...(transaction.meta.postTokenBalances ?? [])])
    if (balance.mint !== terms.quoteMint) fail(E.RECEIPT, 'Another token moved in the payout')
  const amount = BigInt(terms.amount), deltas = tokenDeltas(transaction, terms.quoteMint)
  for (const [address, entry] of deltas) {
    const expected = address === terms.custodyTokenAccount ? -amount : address === terms.walletTokenAccount ? amount : 0n
    if (entry.delta !== expected) fail(E.RECEIPT, `Exact ${terms.quoteMint} balance delta mismatch on ${address}`)
  }
  if (deltas.get(terms.custodyTokenAccount)?.delta !== -amount || deltas.get(terms.walletTokenAccount)?.delta !== amount)
    fail(E.RECEIPT, 'Custody or launcher balance evidence missing')
  const { preBalances: pre, postBalances: post } = transaction.meta, fee = BigInt(transaction.meta.fee)
  const moved = i => BigInt(post[i]) - BigInt(pre[i]), walletIndex = keys.indexOf(terms.walletTokenAccount)
  const rent = walletIndex >= 0 ? moved(walletIndex) : 0n
  if (rent < 0n || rent > BigInt(terms.rentCap)) fail(E.RECEIPT, "The launcher's stock account gained more than its rent, or lost SOL")
  keys.forEach((address, i) => {
    if (moved(i) !== (i === 0 ? -fee - rent : i === walletIndex ? rent : 0n)) fail(E.RECEIPT, `Unexpected SOL movement on ${address}`)
  })
  const created = !(transaction.meta.preTokenBalances ?? []).some(b => keys[b.accountIndex] === terms.walletTokenAccount)
  return { kind: 'stock-launcher-payout', signature: transaction.transaction.signatures?.[0] ?? signature ?? null, slot: transaction.slot,
    amount: text(amount), wallet: terms.wallet, walletTokenAccount: terms.walletTokenAccount, custodyTokenAccount: terms.custodyTokenAccount,
    networkFee: text(fee), accountCreated: created, rent: text(rent) }
}

export function createStockLauncherPayouts({ pool, connection, verification = null, env = process.env, custody = STOCK_FEE_CUSTODY,
  store = createStockExecutionStore(pool), listMarkets = options => listStockMarkets(pool, options), ledger = readMarketLauncherLedger,
  minimum = launcherPayoutMinimum, loadTransaction = (rpc, signature) => loadFinalizedTransaction(rpc, signature),
  custodyBalance = asset => custodyStockBalance(connection, asset, custody), loadSigner = null, mintCheck = null, follow = {}, hooks = {} }) {
  const usable = mintCheck ?? (asset => checkTipMint(connection, { mint: asset.mint, program: asset.tokenProgram, decimals: asset.decimals }, 'confirmed'))

  // One market's payout decision from the launcher ledger, read-only (db: the locked connection, or the pool for a plan).
  async function decide(db, market) {
    const base = { kind: 'payout', repoId: String(market.repoId), assetId: market.quoteAssetId, wallet: market.launcherWallet }
    const row = await ledger(db, market.repoId)
    if (!row || row.launcherWallet !== market.launcherWallet || row.assetId !== market.quoteAssetId || row.quoteMint !== market.quoteMint)
      return { ...base, status: 'ERROR', reason: "The launcher ledger does not match the market's stamp or launcher wallet" }
    let earnings
    try { earnings = launcherEarnings(row) } catch (error) {
      if (!(error instanceof StockLauncherBalanceError)) throw error
      // The one expected cause: a graduated position's claim took fees the next DAMM checkpoint has not credited yet.
      if (await store.collectedAheadOfCheckpoints(db, market.repoId)) return { ...base, status: 'WAITING',
        reason: 'A graduated-pool collection took fees the DAMM checkpoints have not credited yet; payouts wait for the next checkpoint' }
      return { ...base, status: 'REVIEW', reason: error.message }
    }
    const floor = minimum(market.quoteAssetId)
    const amounts = { payable: text(earnings.payable), minimum: text(floor), collected: text(earnings.collected), paid: text(earnings.paid),
      pending: text(earnings.pending), earned: text(earnings.earned) }
    if (earnings.pending > 0n) return { ...base, ...amounts, status: 'IN_FLIGHT' }
    if (earnings.payable === 0n) return { ...base, ...amounts, status: 'NOTHING' }
    if (earnings.payable < floor) return { ...base, ...amounts, status: 'BELOW_MINIMUM' }
    return { ...base, ...amounts, status: 'PAYABLE', amount: text(earnings.payable) }
  }
  // A PAYABLE decision against custody's live balance (custodyGate): still PAYABLE, or WAITING; a shortfall throws.
  async function covered(db, decision, asset) {
    const balance = BigInt(await custodyBalance(asset))
    const gate = custodyGate({ balance, amount: BigInt(decision.amount), ledger: await store.custodyLedger(db, asset.assetId) })
    const custodyView = { custodyBalance: text(gate.balance), custodyHolds: text(gate.holds), custodyNeeded: text(gate.needed) }
    return gate.ok ? { ...decision, ...custodyView } : { ...decision, ...custodyView, status: 'WAITING',
      reason: `Custody holds ${gate.balance} raw units, less than this payout and the payouts still pending (${gate.needed})` }
  }
  const plan = async market => {
    const decision = await decide(pool, market)
    return decision.status === 'PAYABLE' ? covered(pool, decision, quoteOfMarket(market)) : decision
  }

  async function settle(db, row, { transaction, intent, stored }) {
    const base = { kind: 'payout', repoId: String(row.repoId), wallet: row.wallet, signature: row.signature }
    let receipt
    try {
      assertSignedMessage(transaction, stored)
      receipt = checkLauncherPayoutReceipt({ transaction, terms: intent.terms, signature: row.signature })
      if (receipt.amount !== row.amount || receipt.wallet !== row.wallet) fail(E.RECEIPT, 'The receipt pays another amount or wallet than the row')
    } catch (error) {
      await raiseExecutionAlert(db, { repoId: row.repoId, key: `payout:${row.id}`, detail: { code: E.RECEIPT, table: 'stock_launcher_payouts',
        id: String(row.id), wallet: row.wallet, signature: row.signature, reason: error.message } })
      return { ...base, status: 'REVIEW', reason: error.message }
    }
    const settled = await store.settlePayout(db, { id: row.id, receipt: { state: 'settled', ...receipt,
      intent: { blockhash: intent.blockhash, lastValidBlockHeight: intent.lastValidBlockHeight, networkFee: intent.networkFee } } })
    if (!settled) return { ...base, status: (await store.payout(db, row.id))?.status?.toUpperCase() ?? 'REVIEW', reason: 'The row was no longer pending' }
    return { ...base, status: 'SETTLED', amount: receipt.amount, accountCreated: receipt.accountCreated }
  }

  const abort = (db, row) => async ({ intent, reason }) => {
    await store.abortPayout(db, { id: row.id, receipt: { state: 'aborted', reason, abortedAt: new Date().toISOString(), intent } })
    return { kind: 'payout', repoId: String(row.repoId), wallet: row.wallet, signature: row.signature, status: 'ABORTED', reason }
  }
  // One pending row, under the market's lock: settled, rebroadcast, aborted or left waiting, as its chain state says.
  const finish = (db, row, dryRun = false) => recoverPendingRow({ row, kind: 'payout', connection, verification, loadTransaction, dryRun,
    settle: evidence => settle(db, row, evidence), abort: abort(db, row) })

  // Under the market's lock: the decision, custody and every check, then signing, the pending row and the first send. Returns the
  // sent row, or the decision not to pay (no key is loaded for it).
  async function signAndSend(db, repoId) {
    const [market] = await listMarkets({ repoId: String(repoId) })
    if (!market) fail(E.NOT_EXECUTABLE, 'Not a launched, indexed and finalized stock-paired market')
    const asset = quoteOfMarket(market)
    const decided = await decide(db, market)
    // Custody is checked before any key is loaded: a shortfall throws, an uncovered payout waits.
    const decision = decided.status === 'PAYABLE' ? await covered(db, decided, asset) : decided
    if (decision.status !== 'PAYABLE') return { decision }
    let wallet
    try { wallet = new PublicKey(market.launcherWallet) } catch { fail(E.NOT_EXECUTABLE, 'The launcher wallet is not a Solana address') }
    if (!PublicKey.isOnCurve(wallet.toBytes()) || wallet.toBase58() === custody) fail(E.NOT_EXECUTABLE, 'The launcher wallet must be a normal wallet other than custody')
    const amount = BigInt(decision.amount)
    const checked = await usable(asset)
    if (!checked?.mint) fail(E.NOT_EXECUTABLE, 'The stock mint could not be read')
    // The rent of the account Token-2022 creates for this mint: the most the launcher's account may gain (a pre-funded address
    // gains less).
    const rentCap = BigInt(await connection.getMinimumBalanceForRentExemption(associatedAccountLength(checked.mint)))
    const signer = await loadSigner('partner')
    if (signer.publicKey.toBase58() !== custody) fail(E.SIGNER_MISMATCH, 'The partner key is not the custody wallet')
    const built = launcherPayoutInstructions({ custody, wallet, mint: asset.mint, decimals: asset.decimals, amount })
    const terms = { purpose: 'stock-launcher-payout', policyVersion: POLICY_VERSION, repoId: String(repoId), assetId: asset.assetId,
      quoteMint: asset.mint, decimals: asset.decimals, wallet: wallet.toBase58(), walletTokenAccount: built.walletTokenAccount, custody,
      custodyTokenAccount: built.custodyTokenAccount, amount: text(amount), rentCap: text(rentCap),
      ledger: { earned: decision.earned, collected: decision.collected, paid: decision.paid, pending: decision.pending },
      custodyCheck: { balance: decision.custodyBalance, holds: decision.custodyHolds, needed: decision.custodyNeeded } }
    const landing = await signStockTransaction({ connection, instructions: built.instructions, signer })
    // Durable before broadcast: from here on, only recovery's rules decide what becomes of this transaction.
    const row = await store.insertPayout(db, { repoId: String(repoId), assetId: asset.assetId, quoteMint: asset.mint, wallet: terms.wallet,
      amount: terms.amount, signature: landing.signature, signedTransaction: landing.raw.toString('base64'), receipt: pendingIntent({ kind: 'payout', landing, terms }) })
    await hooks.afterIntent?.(row)
    return { row, landing, refused: await sendFirst(connection, landing) }
  }

  // Pays the launcher of one market what the ledger says is payable now, if it reaches the minimum and custody covers it. Below
  // the minimum, with nothing payable, a payout in flight or custody not covering it, it returns that decision (a shortfall
  // throws): no key is loaded and nothing is signed or sent.
  async function pay({ repoId }) {
    assertStockExecutionEnabled('payouts', env)
    assertSigner(loadSigner, 'payouts')
    if (!isRepoId(repoId)) fail(E.INVALID_REQUEST, 'A payout needs a repository id')
    await assertExecutionNetwork({ connection, verification })
    const sent = await store.withLock(repoId, db => signAndSend(db, repoId))
    if (sent.decision) return sent.decision
    const base = { kind: 'payout', repoId: String(repoId), wallet: sent.row.wallet, signature: sent.landing.signature }
    const followed = sent.refused ? { state: 'unsettled', reason: sent.refused } : await followLanding({ connection, landing: sent.landing, ...follow })
    if (followed.state === 'unsettled') return { ...base, status: 'PENDING', reason: followed.reason }
    // Finalized (successfully or not): settled or aborted under a fresh lock, exactly as recovery would, unless recovery already has.
    return store.withLock(repoId, async db => {
      const row = await store.payout(db, sent.row.id)
      if (row?.status !== 'pending') return { ...base, status: String(row?.status ?? 'unknown').toUpperCase() }
      return { kind: 'payout', ...await finish(db, row) }
    })
  }

  // Every pending payout (or one market's): settled, rebroadcast, aborted or left waiting. Needs no key. dryRun changes nothing.
  async function recover({ repoId = null, dryRun = false } = {}) {
    if (!dryRun) assertStockExecutionEnabled('payouts', env)
    const markets = await store.pendingMarkets('payout', { repoId })
    if (!markets.length) return []
    await assertExecutionNetwork({ connection, verification })
    const results = []
    for (const id of markets) {
      try {
        results.push(...await store.withLock(id, async db => {
          const done = []
          for (const row of await store.pendingPayouts(db, { repoId: id })) {
            try { done.push({ kind: 'payout', wallet: row.wallet, ...await finish(db, row, dryRun) }) }
            catch (error) { done.push(errorResult({ kind: 'payout', repoId: id, signature: row.signature }, error)) }
          }
          return done
        }))
      } catch (error) { results.push(errorResult({ kind: 'payout', repoId: id }, error)) }
    }
    return results
  }

  return { plan, pay, recover }
}
