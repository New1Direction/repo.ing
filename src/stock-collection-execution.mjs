import { createHash } from 'node:crypto'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'
import { quoteOfMarket } from './quote-assets.mjs'
import { LAUNCHER_DEN, LAUNCHER_NUM } from './stock-fee-policy.mjs'
import { checkTipMint } from './tip-tokens.mjs'
import { DBC_PROGRAM, STOCK_COLLECTION_SOURCES, STOCK_FEE_CUSTODY, STOCK_PARTNER_WALLET, checkStockCollectionReceipt,
  createStockChainReader, createStockCollections, listStockMarkets, stockCollectionTermsHash, tokenDeltas } from './stock-collections.mjs'
import { stockCustodyAccount } from './stock-reconcile.mjs'
import { STOCK_EXECUTION_ERRORS as E, assertExecutionNetwork, assertSignedMessage, assertStockExecutionEnabled,
  errorResult, fail, isRepoId, loadStockSigner, pendingIntent, raiseExecutionAlert, recoverPendingRow, sendAndFollow,
  signStockTransaction } from './stock-execution.mjs'
import { createStockExecutionStore } from './stock-execution-store.mjs'

// Collecting a stock-paired market's fees into custody (docs/STOCK_QUOTES.md, "Execution (off by default)"), behind
// STOCK_COLLECTIONS_EXECUTION_ENABLED=true. A collection executes only what src/stock-collections.mjs previews: under the
// market's lock the preview is rebuilt from fresh finalized reads and the stock ledgers, and it runs only if that source still
// MATCHes and its terms hash is the reviewed one. It is signed by the key the SOL claims sign with for that side (the platform
// creator for creator fees, the partner for partner fees), recorded pending with its signed bytes before it is sent, and settled
// from its finalized receipt (checkStockCollectionReceipt: the exact signed message, exact Token-2022 deltas and the program's
// claim event), with the amount received split into the launcher's and the accumulator's parts. Every source lands in the one
// stock custody account, stockCustodyAccount(fee claimer, mint), that the reconciliation watches and payouts leave from.

const SIGNER_ROLE = Object.freeze({ dbc_creator: 'creator', damm_creator: 'creator', dbc_partner: 'partner', damm_partner: 'partner' })
const CREATE_IDEMPOTENT = Buffer.from([1]).toString('base64')
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const text = value => String(value)

// A MATCH preview's described instructions as transaction instructions, once they are exactly the ones its terms hash and the
// shape of a collection: the custody's two token accounts created idempotently (paid by the signer), then the one claim of the
// source's program, with the reviewed signer the only signer.
export function collectionTransactionInstructions(previewed) {
  const { terms, instructions } = previewed
  if (!Array.isArray(instructions) || sha256(instructions) !== terms?.instructionsSha256) fail(E.TERMS_CHANGED, 'The previewed instructions are not the ones their terms hash')
  const claim = terms.source.startsWith('damm_') ? CP_AMM_PROGRAM_ID : DBC_PROGRAM
  const programs = [ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, claim].map(program => program.toBase58())
  if (instructions.length !== 3 || instructions.some((ix, i) => ix.program !== programs[i])) fail(E.NOT_EXECUTABLE, 'A collection is two idempotent token accounts and one claim')
  if (instructions.slice(0, 2).some(ix => ix.data !== CREATE_IDEMPOTENT || ix.accounts[2]?.address !== terms.receiver))
    fail(E.NOT_EXECUTABLE, "A collection creates only the custody's own token accounts")
  if (instructions.some(ix => ix.accounts.some(a => a.signer && a.address !== terms.signer))) fail(E.NOT_EXECUTABLE, 'Only the reviewed signer may sign a collection')
  return instructions.map(ix => new TransactionInstruction({ programId: new PublicKey(ix.program), data: Buffer.from(ix.data, 'base64'),
    keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.address), isSigner: a.signer, isWritable: a.writable })) }))
}

// The launcher's and the accumulator's parts of what a collection received. A curve claim takes exactly the reviewed amount. A
// graduated position's claim takes everything accrued when it runs, so it may receive more than its review; the excess is split
// as the next DAMM checkpoint credits it (dammCheckpoint, src/stock-fee-policy.mjs): on the creator side the launcher's running
// total is floor(cumulative × 150 / 497), so the launcher gets its growth from the reviewed cumulative to the one collected; the
// partner side's excess goes to the accumulator whole. The two parts always add up to the amount received.
export function settledCollectionSplit(terms, receivedAmount) {
  const reviewed = BigInt(terms.amount), received = BigInt(receivedAmount), excess = received - reviewed
  const launcher = BigInt(terms.launcherAmount), accumulator = BigInt(terms.accumulatorAmount)
  if (launcher + accumulator !== reviewed) fail(E.RECEIPT, "The reviewed launcher and accumulator parts do not add up to the reviewed amount")
  if (excess < 0n) fail(E.RECEIPT, 'The collection received less than its review')
  if (excess === 0n) return { launcherAmount: launcher, accumulatorAmount: accumulator }
  if (!terms.source.startsWith('damm_')) fail(E.RECEIPT, 'A curve claim received more than its review')
  const share = value => value * LAUNCHER_NUM / LAUNCHER_DEN, earned = BigInt(terms.ledger.earned)
  const launcherExcess = terms.source === 'damm_creator' ? share(earned + excess) - share(earned) : 0n
  return { launcherAmount: launcher + launcherExcess, accumulatorAmount: accumulator + excess - launcherExcess }
}

export function createStockCollectionExecutor({ pool, connection, verification = null, config, env = process.env,
  custody = STOCK_FEE_CUSTODY, partner = STOCK_PARTNER_WALLET, stockConfigs = undefined, legacyConfigs = undefined,
  store = createStockExecutionStore(pool), previewMarket = null, listMarkets = options => listStockMarkets(pool, options),
  checkReceipt = checkStockCollectionReceipt, loadTransaction = (rpc, signature) => loadFinalizedTransaction(rpc, signature),
  loadSigner = role => loadStockSigner(role, env), mintCheck = null, follow = {}, hooks = {} }) {
  // PR-E's previews, built on first use: nothing is constructed or read until a plan or a collection asks.
  let previews = null
  const preview = market => (previewMarket ?? (previews ??= createStockCollections({ pool, custody,
    reader: createStockChainReader({ connection, verification, config, legacyConfigs, stockConfigs, partner }) }).previewMarket))(market)
  const usable = mintCheck ?? (asset => checkTipMint(connection, { mint: asset.mint, program: asset.tokenProgram, decimals: asset.decimals }, 'confirmed'))

  // Every source of one market, read-only: MATCH sources carry the terms hash a collection would execute.
  async function plan(market) {
    const result = await preview(market)
    const base = { kind: 'collection', repoId: String(market.repoId), assetId: market.quoteAssetId }
    if (!['COLLECTABLE', 'NOTHING'].includes(result.status)) return [{ ...base, status: 'ERROR', reason: `${result.status}: ${result.error ?? 'preview unavailable'}` }]
    return result.sources.map(s => ({ ...base, source: s.source, status: s.status, ...(s.status === 'MATCH'
      ? { amount: s.amount, launcherAmount: s.launcherAmount, accumulatorAmount: s.accumulatorAmount, signer: s.signer, termsHash: s.termsHash }
      : { reason: s.reason, onchain: s.onchain, ledgerExpected: s.ledgerExpected }) }))
  }

  async function settle(db, row, { transaction, intent, stored }) {
    const base = { kind: 'collection', repoId: String(row.repoId), source: row.source, signature: row.signature }
    let receipt, split
    try {
      assertSignedMessage(transaction, stored)
      receipt = checkReceipt({ transaction, terms: intent.terms, signature: row.signature })
      // What the pool released, what custody received and what the claim reports must be one amount (xStocks charge no
      // transfer fee); the receipt check holds them to it, and so does this, in exact raw deltas.
      const deltas = tokenDeltas(transaction, intent.terms.quoteMint), amount = BigInt(receipt.amount)
      if (deltas.get(intent.terms.receiverTokenAccount)?.delta !== amount || deltas.get(intent.terms.sourceVault)?.delta !== -amount)
        fail(E.RECEIPT, 'What the pool released, what custody received and what the claim reports differ')
      split = settledCollectionSplit(intent.terms, receipt.amount)
    } catch (error) {
      // The transaction landed: never aborted, held for a person.
      await raiseExecutionAlert(db, { repoId: row.repoId, key: `collection:${row.id}`, detail: { code: E.RECEIPT, table: 'stock_fee_collections',
        id: String(row.id), source: row.source, signature: row.signature, reason: error.message } })
      return { ...base, status: 'REVIEW', reason: error.message }
    }
    const settled = await store.settleCollection(db, { id: row.id, actualAmount: receipt.amount, launcherAmount: text(split.launcherAmount),
      accumulatorAmount: text(split.accumulatorAmount), receipt: { state: 'settled', ...receipt, launcherAmount: text(split.launcherAmount),
        accumulatorAmount: text(split.accumulatorAmount), intent: { blockhash: intent.blockhash, lastValidBlockHeight: intent.lastValidBlockHeight,
          networkFee: intent.networkFee } } })
    if (!settled) return { ...base, status: (await store.collection(db, row.id))?.status?.toUpperCase() ?? 'REVIEW', reason: 'The row was no longer pending' }
    return { ...base, status: 'SETTLED', amount: receipt.amount, launcherAmount: text(split.launcherAmount), accumulatorAmount: text(split.accumulatorAmount) }
  }

  const abort = (db, row) => async ({ intent, reason }) => {
    await store.abortCollection(db, { id: row.id, receipt: { state: 'aborted', reason, abortedAt: new Date().toISOString(), intent } })
    return { kind: 'collection', repoId: String(row.repoId), source: row.source, signature: row.signature, status: 'ABORTED', reason }
  }

  // Executes one previewed collection. termsHash is the hash of the terms the caller reviewed (a plan's MATCH).
  async function collect({ repoId, source, termsHash }) {
    assertStockExecutionEnabled('collections', env)
    if (!isRepoId(repoId) || !STOCK_COLLECTION_SOURCES.includes(source) || !/^[0-9a-f]{64}$/.test(String(termsHash ?? '')))
      fail(E.INVALID_REQUEST, 'A collection needs a repository id, a source and the reviewed terms hash')
    await assertExecutionNetwork({ connection, verification })
    return store.withLock(repoId, async db => {
      const [market] = await listMarkets({ repoId: String(repoId) })
      if (!market) fail(E.NOT_EXECUTABLE, 'Not a launched, indexed and finalized stock-paired market')
      const asset = quoteOfMarket(market)
      const result = await preview(market)
      if (!['COLLECTABLE', 'NOTHING'].includes(result.status)) fail(E.NOT_EXECUTABLE, `${result.status}: ${result.error ?? 'preview unavailable'}`)
      const current = result.sources.find(s => s.source === source)
      if (!current || current.status !== 'MATCH') {
        return { kind: 'collection', repoId: String(repoId), source, status: 'NOT_COLLECTABLE', reason: current ? `${current.status}: ${current.reason}` : 'No such source' }
      }
      if (current.termsHash !== termsHash || stockCollectionTermsHash(current.terms) !== termsHash)
        fail(E.TERMS_CHANGED, 'The collection terms changed since they were reviewed; preview and review again')
      const terms = current.terms
      if (terms.assetId !== asset.assetId || terms.quoteMint !== asset.mint || terms.receiver !== custody || terms.repoId !== String(repoId))
        fail(E.NOT_EXECUTABLE, 'The terms name another market, stock or custody')
      // The fee claimer's Token-2022 account for the stock: the one custody account (PR-E's reader holds the fee claimer to partner).
      if (terms.receiverTokenAccount !== stockCustodyAccount(partner, asset.mint)) fail(E.NOT_EXECUTABLE, 'The collection does not land in the stock custody account')
      const instructions = collectionTransactionInstructions(current)
      if ((await store.pendingCollections(db, { repoId })).some(row => row.source === source))
        fail(E.IN_FLIGHT, `A ${source} collection is already in flight for this market`)
      await usable(asset)
      const signer = loadSigner(SIGNER_ROLE[source])
      if (signer.publicKey.toBase58() !== terms.signer) fail(E.SIGNER_MISMATCH, `The ${SIGNER_ROLE[source]} key is not the reviewed signer`)
      const landing = await signStockTransaction({ connection, instructions, signer })
      // Durable before broadcast: from here on, only recovery's rules decide what becomes of this transaction.
      const row = await store.insertCollection(db, { repoId: String(repoId), assetId: asset.assetId, quoteMint: asset.mint, source,
        reviewedAmount: terms.amount, launcherAmount: terms.launcherAmount, accumulatorAmount: terms.accumulatorAmount, termsHash,
        signature: landing.signature, signedTransaction: landing.raw.toString('base64'), receipt: pendingIntent({ kind: 'collection', landing, terms }) })
      await hooks.afterIntent?.(row)
      const followed = await sendAndFollow({ connection, landing, ...follow })
      if (followed.state === 'unsettled') return { kind: 'collection', repoId: String(repoId), source, signature: landing.signature, status: 'PENDING', reason: followed.reason }
      // Finalized (successfully or not): settled or aborted from the finalized transaction, exactly as recovery would.
      return { kind: 'collection', source, ...await recoverPendingRow({ row, kind: 'collection', connection, verification, loadTransaction,
        settle: evidence => settle(db, row, evidence), abort: abort(db, row) }) }
    })
  }

  // Every pending collection (or one market's): settled, rebroadcast, aborted or left waiting. dryRun changes nothing.
  async function recover({ repoId = null, dryRun = false } = {}) {
    if (!dryRun) assertStockExecutionEnabled('collections', env)
    const results = []
    for (const id of await store.pendingMarkets('collection', { repoId })) {
      try {
        const outcome = await store.withLock(id, async db => {
          const rows = await store.pendingCollections(db, { repoId: id }), done = []
          for (const row of rows) {
            try {
              done.push({ kind: 'collection', source: row.source, ...await recoverPendingRow({ row, kind: 'collection', connection, verification,
                loadTransaction, dryRun, settle: evidence => settle(db, row, evidence), abort: abort(db, row) }) })
            } catch (error) { done.push(errorResult({ kind: 'collection', repoId: id, source: row.source, signature: row.signature }, error)) }
          }
          return done
        })
        results.push(...(Array.isArray(outcome) ? outcome : [{ kind: 'collection', ...outcome }]))
      } catch (error) { results.push(errorResult({ kind: 'collection', repoId: id }, error)) }
    }
    return results
  }

  return { plan, collect, recover }
}

