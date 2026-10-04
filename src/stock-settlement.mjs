import { createHash } from 'node:crypto'
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
  getTransferFeeConfig, unpackAccount, unpackMint } from '@solana/spl-token'
import { CpAmm, SwapMode, derivePositionNftAccount, getCurrentPoint } from '@meteora-ag/cp-amm-sdk'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'
import { stockAccumulator, stockAsset } from './stock-accumulator.mjs'
import { REPOING_MINT, STOCK_POOL_OWNERS, activeCanonicalPool, readOwnedPosition, verifyCanonicalPool } from './stock-canonical-pools.mjs'
import { STOCK_FEE_CUSTODY } from './stock-collections.mjs'
import { SETTLEMENT_KINDS, analyzeSettlementTransaction, lockCoverage } from './stock-pool-transactions.mjs'

export { SETTLEMENT_KINDS, analyzeSettlementTransaction, lockCoverage }

// Settling a stock's accumulator (docs/STOCK_QUOTES.md, "Accumulator and settlement"): about half of what is available is
// swapped into REPOING through the stock's canonical REPOING/<stock> pool and both sides are added to the owner's position as
// permanently locked liquidity. The owner does this himself. Here there is only:
//   - previewStockSettlement: the bounded plan (amounts, slippage and price-impact limits, the exact instructions he would
//     sign, the hash of its terms), read-only;
//   - verifyStockSettlementReceipt / recordStockSettlementReceipt: his finalized seed, swap or add-liquidity transaction checked
//     against the canonical pool with exact balance deltas (src/stock-pool-transactions.mjs), then recorded in
//     stock_settlement_receipts, never beyond what the accumulator has collected and not yet spent.
// Nothing here signs or sends a transaction or loads a key.

// Defaults, and the most an operator may allow. A preview never plans past them; a larger settlement is several smaller ones.
export const SETTLEMENT_DEFAULTS = Object.freeze({ slippageBps: 100, priceImpactBps: 300 })
export const SETTLEMENT_LIMITS = Object.freeze({ slippageBps: 500, priceImpactBps: 1000 })
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = value => value.toString()
const lockKey = assetId => `stock-accumulator:${assetId}`
const bps = (value, name) => {
  if (!Number.isInteger(value) || value < 1 || value > SETTLEMENT_LIMITS[name]) throw Error(`${name} must be a whole number from 1 to ${SETTLEMENT_LIMITS[name]}`)
  return value
}
const describe = (ix, name) => ({ program: ix.programId.toBase58(), name,
  accounts: ix.keys.map(k => ({ address: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })), data: Buffer.from(ix.data).toString('base64') })

// |Δprice| / price in basis points, rounded up, from two Q64 square-root prices (price = sqrtPrice², exact BigInt arithmetic).
export function priceImpactBps(sqrtBefore, sqrtAfter) {
  const before = BigInt(text(sqrtBefore)) ** 2n, after = BigInt(text(sqrtAfter)) ** 2n
  if (before <= 0n) throw Error('Pool has no price')
  const change = after > before ? after - before : before - after
  return (change * 10_000n + before - 1n) / before
}

// The largest amount (≤ amount) whose half swaps within the price-impact bound, by bisection over the quote: the bound is
// monotonic in the swap size. null when even 2 raw units exceed it.
export function largestWithinImpact(amount, impactOf, bound) {
  const fits = value => { try { return impactOf(value / 2n) <= BigInt(bound) } catch { return false } }
  if (fits(amount)) return amount
  let low = 1n, high = amount
  for (let i = 0; i < 128 && high - low > 1n; i++) { const mid = (low + high) / 2n; if (fits(mid)) low = mid; else high = mid }
  return low >= 2n && fits(low) ? low : null
}

// The minimum output at a slippage bound, floored as Meteora's SDKs compute it (src/trade-slippage.mjs). The plan requires the
// SDK's own minimum to equal it: cp-amm-sdk takes slippage in basis points.
export const minimumAfterSlippage = (output, slippageBps) => BigInt(output) * BigInt(10_000 - slippageBps) / 10_000n

// Liquidity already recorded into a position by earlier receipts of this stock.
async function recordedLiquidity(db, assetId, position) {
  const { rows: [row] } = await db.query(`select coalesce(sum((evidence->'liquidity'->>$2)::numeric),0)::text as total
    from stock_settlement_receipts where asset_id=$1`, [assetId, position])
  return row.total
}

// The bounded plan for settling a stock's available accumulator. Refused (with the reason) unless the accumulator reconciles,
// its canonical pool is registered and still checks out on chain, and the swap fits the price-impact bound.
export async function previewStockSettlement({ pool, connection, assetId, maxAmount = null, slippageBps = SETTLEMENT_DEFAULTS.slippageBps,
  priceImpactBps: impactBound = SETTLEMENT_DEFAULTS.priceImpactBps, owners = STOCK_POOL_OWNERS, repoingMint = REPOING_MINT, accumulator = null }) {
  const asset = stockAsset(assetId)
  bps(slippageBps, 'slippageBps'); bps(impactBound, 'priceImpactBps')
  if (maxAmount != null && !/^[1-9]\d*$/.test(String(maxAmount))) throw Error('maxAmount must be a positive whole number of raw units')
  const summary = accumulator ?? await stockAccumulator(pool, asset.assetId)
  const base = { assetId: asset.assetId, symbol: asset.symbol, quoteMint: asset.mint, available: summary.totals.available,
    bounds: { slippageBps, priceImpactBps: impactBound, maxAmount: maxAmount == null ? null : String(maxAmount) }, broadcast: false }
  const refused = reason => ({ ...base, status: 'REFUSED', reason })
  if (summary.status !== 'MATCH') return refused(`The ${asset.symbol} accumulator does not reconcile: ${summary.problems.join('; ')}`)
  const canonical = await activeCanonicalPool(pool, asset.assetId)
  if (!canonical) return refused(`No canonical REPOING/${asset.symbol} pool is registered`)
  // The pool is checked again exactly as it was registered, its creation included.
  const creationSignature = canonical.evidence?.creation?.signature
  if (!creationSignature) return refused('The canonical pool was registered without its creation transaction; register it again')
  const verified = await verifyCanonicalPool({ connection, assetId: asset.assetId, pool: canonical.pool, position: canonical.position, creationSignature,
    owners, repoingMint })
  const available = BigInt(summary.totals.available)
  const cap = maxAmount == null ? available : (BigInt(maxAmount) < available ? BigInt(maxAmount) : available)
  if (cap < 2n) return refused(`Nothing available to settle: ${available} raw ${asset.symbol} collected and unspent`)
  const amm = new CpAmm(connection), poolKey = new PublicKey(canonical.pool)
  const state = await amm.fetchPoolState(poolKey)
  if (Buffer.from(state.poolFees.baseFee.baseFeeInfo.data).readUInt8(8) === 2) return refused('The canonical pool uses a rate-limited fee; plan this settlement by hand')
  const [stockInfo, repoingInfo] = await connection.getMultipleAccountsInfo([new PublicKey(asset.mint), new PublicKey(repoingMint)], 'finalized')
  const stockMint = unpackMint(new PublicKey(asset.mint), stockInfo, TOKEN_2022_PROGRAM_ID), repoing = unpackMint(new PublicKey(repoingMint), repoingInfo, TOKEN_PROGRAM_ID)
  if (getTransferFeeConfig(stockMint)) return refused(`${asset.symbol} now charges a transfer fee; the plan's exact amounts would not hold`)
  const sides = verified.evidence.pool.sides
  const decimals = side => (side === sides.stock ? asset.decimals : repoing.decimals)
  const currentPoint = await getCurrentPoint(connection, state.activationType)
  const quote = amountIn => amm.getQuote2({ inputTokenMint: new PublicKey(asset.mint), slippage: slippageBps, currentPoint, poolState: state,
    tokenADecimal: decimals('A'), tokenBDecimal: decimals('B'), hasReferral: false, swapMode: SwapMode.ExactIn, amountIn: new BN(text(amountIn)) })
  const amount = largestWithinImpact(cap, half => priceImpactBps(state.sqrtPrice, quote(half).nextSqrtPrice), impactBound)
  if (amount == null) return refused(`Even the smallest settlement moves the REPOING/${asset.symbol} price more than ${impactBound} bps`)
  const swapAmount = amount / 2n, keep = amount - swapAmount, swapQuote = quote(swapAmount)
  const expectedOut = BigInt(text(swapQuote.outputAmount)), minOut = minimumAfterSlippage(expectedOut, slippageBps)
  if (!swapQuote.amountLeft.isZero() || BigInt(text(swapQuote.minimumAmountOut)) !== minOut)
    return refused('The swap quote does not fill completely or disagrees with the slippage bound')
  if (minOut <= 0n) return refused('The swap would return no REPOING')
  const [maxA, maxB] = sides.stock === 'A' ? [keep, minOut] : [minOut, keep]
  // Rounded safely below what the maximum deposits allow, as the SOL liquidity deployment does (src/liquidity-deployment.mjs).
  const liquidity = amm.getLiquidityDelta({ maxAmountTokenA: new BN(text(maxA)), maxAmountTokenB: new BN(text(maxB)), sqrtPrice: swapQuote.nextSqrtPrice,
    sqrtMinPrice: state.sqrtMinPrice, sqrtMaxPrice: state.sqrtMaxPrice, collectFeeMode: state.collectFeeMode }).muln(9999).divn(10000)
  if (liquidity.lten(0)) return refused('The deposit would add no liquidity')
  const owner = new PublicKey(verified.owner), position = new PublicKey(verified.position)
  const positionNftAccount = derivePositionNftAccount(new PublicKey(verified.evidence.position.nftMint))
  const programOf = side => (side === sides.stock ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)
  const ownerStock = getAssociatedTokenAddressSync(new PublicKey(asset.mint), owner, true, TOKEN_2022_PROGRAM_ID)
  const ownerRepoing = getAssociatedTokenAddressSync(new PublicKey(repoingMint), owner, true, TOKEN_PROGRAM_ID)
  // The plan spends from the position owner's own stock account; collected fees sit in custody until the owner moves them.
  const ownerAccount = await connection.getAccountInfo(ownerStock, 'finalized')
  const held = ownerAccount ? unpackAccount(ownerStock, ownerAccount, TOKEN_2022_PROGRAM_ID).amount : 0n
  if (held < amount) return refused(`The owner wallet ${verified.owner} holds ${held} raw ${asset.symbol}; move at least ${amount - held} ` +
    `from custody (${STOCK_FEE_CUSTODY}) to it first`)
  const accountOf = side => (side === sides.stock ? ownerStock : ownerRepoing)
  const shared = { tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
    tokenAProgram: programOf('A'), tokenBProgram: programOf('B') }
  const instructions = [
    describe(createAssociatedTokenAccountIdempotentInstruction(owner, ownerRepoing, owner, new PublicKey(repoingMint), TOKEN_PROGRAM_ID), 'createIdempotent (owner REPOING account)'),
    describe(await amm._program.methods.swap2({ amount0: new BN(text(swapAmount)), amount1: new BN(text(minOut)), swapMode: SwapMode.ExactIn })
      .accountsPartial({ poolAuthority: amm.poolAuthority, pool: poolKey, payer: owner, inputTokenAccount: ownerStock, outputTokenAccount: ownerRepoing,
        referralTokenAccount: null, ...shared }).instruction(), `swap2 (${asset.symbol} → REPOING)`),
    describe(await amm.buildAddLiquidityInstruction({ pool: poolKey, position, positionNftAccount, owner, tokenAAccount: accountOf('A'),
      tokenBAccount: accountOf('B'), ...shared, liquidityDelta: liquidity, tokenAAmountThreshold: new BN(text(maxA)), tokenBAmountThreshold: new BN(text(maxB)) }), 'add_liquidity'),
    describe(await amm._program.methods.permanentLockPosition(liquidity).accountsPartial({ pool: poolKey, position, positionNftAccount, signer: owner })
      .instruction(), 'permanent_lock_position'),
  ]
  const terms = { purpose: 'stock-settlement', assetId: asset.assetId, quoteMint: asset.mint, repoingMint, pool: canonical.pool, position: verified.position,
    owner: verified.owner, amount: text(amount), swap: { amountIn: text(swapAmount), minimumOut: text(minOut), expectedOut: text(expectedOut),
      priceImpactBps: text(priceImpactBps(state.sqrtPrice, swapQuote.nextSqrtPrice)) },
    deposit: { stock: text(keep), repoingMax: text(minOut), liquidity: text(liquidity), tokenAThreshold: text(maxA), tokenBThreshold: text(maxB) },
    lock: { liquidity: text(liquidity) }, bounds: base.bounds, instructionsSha256: sha256(instructions) }
  return { ...base, status: 'PLANNED', limitedBy: amount < cap ? 'price impact' : cap < available ? 'operator maximum' : 'available',
    amount: text(amount), pool: canonical.pool, position: verified.position, owner: verified.owner, positionFullyLocked: verified.fullyLocked,
    swap: terms.swap, deposit: terms.deposit, lock: terms.lock, instructions, terms, termsHash: sha256(terms) }
}

export function describeSettlementPreview(preview) {
  if (preview.status !== 'PLANNED') return [`${preview.symbol} settlement: REFUSED: ${preview.reason}. Nothing would be signed or sent.`]
  const s = preview.swap, d = preview.deposit
  return [`${preview.symbol} settlement preview (nothing is signed or sent; the owner signs this himself):`,
    `  ${preview.available} raw ${preview.symbol} is collected and unspent; this plan settles ${preview.amount} (limited by ${preview.limitedBy}).`,
    `  1. swap ${s.amountIn} raw ${preview.symbol} for at least ${s.minimumOut} raw REPOING (about ${s.expectedOut}) through pool ${preview.pool}, ` +
      `moving its price ${s.priceImpactBps} bps (limit ${preview.bounds.priceImpactBps}, slippage ${preview.bounds.slippageBps} bps);`,
    `  2. add ${d.stock} raw ${preview.symbol} and at most ${d.repoingMax} raw REPOING as ${d.liquidity} liquidity to owner position ${preview.position};`,
    `  3. permanently lock exactly that liquidity. Signed by owner wallet ${preview.owner}. Terms hash ${preview.termsHash}.`,
    '  Afterwards record each finalized transaction with scripts/stock-settlement-receipt.mjs.']
}

// ---------------------------------------------------------------------------------------------------------------------------
// Receipts of the owner's own transactions.

// The owner's finalized transaction, verified as one settlement step of `kind` on the stock's active canonical pool (a second
// RPC, when given, must find exactly the same). Liquidity counts only once it is permanent: every position the transaction
// deposited into must hold nothing unlocked or vesting, and lock at least every deposit recorded into it plus this one.
export async function verifyStockSettlementReceipt({ pool, connection, verification = null, assetId, kind, signature, owners = STOCK_POOL_OWNERS,
  loadTransaction = loadFinalizedTransaction }) {
  const asset = stockAsset(assetId)
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(String(signature ?? ''))) throw Error('Invalid transaction signature')
  const canonical = await activeCanonicalPool(pool, asset.assetId)
  if (!canonical) throw Error(`No canonical REPOING/${asset.symbol} pool is registered; register it before recording receipts`)
  const read = async rpc => {
    const transaction = await loadTransaction(rpc, signature)
    const found = analyzeSettlementTransaction({ transaction, kind, asset, canonical, owners })
    const coder = new CpAmm(rpc)._program.coder.accounts, positions = []
    for (const position of found.positions) positions.push(await readOwnedPosition({ connection: rpc, coder, pool: canonical.pool, position, owners }))
    return { transaction, found, positions }
  }
  const essentials = r => JSON.stringify({ found: r.found, positions: r.positions.map(p => [p.address, p.owner, p.fullyLocked]) },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  const primary = await read(connection)
  if (verification && essentials(await read(verification)) !== essentials(primary)) throw Error('RPC disagreement; verify again')
  const { transaction, found, positions } = primary
  for (const facts of positions) {
    const problem = lockCoverage(facts, await recordedLiquidity(pool, asset.assetId, facts.address), found.liquidity[facts.address])
    if (problem) throw Error(problem)
  }
  const evidence = { slot: transaction.slot, blockTime: transaction.blockTime ?? null, pool: canonical.pool, canonicalPoolId: canonical.id,
    owner: found.owner, events: found.events, swap: found.swap, deposit: found.deposit, deltas: found.deltas, liquidity: found.liquidity,
    positions, verifiedBy: verification ? 2 : 1, networkFee: text(transaction.meta.fee) }
  return { assetId: asset.assetId, quoteMint: asset.mint, kind, signature, quoteSpent: text(found.quoteSpent),
    repoingSpent: text(found.repoingSpent), repoingReceived: text(found.repoingReceived), evidence }
}

// Records a verified receipt. A receipt spends accumulator funds, so it must fit in what was collected and not spent yet:
// settling from the owner's own funds is not an accumulator settlement. Recording the same signature again changes nothing.
export async function recordStockSettlementReceipt(pool, receipt) {
  const asset = stockAsset(receipt.assetId)
  if (receipt.quoteMint !== asset.mint || !SETTLEMENT_KINDS.includes(receipt.kind)) throw Error('Receipt names another mint or an unknown kind')
  const db = await pool.connect()
  try {
    await db.query('begin')
    try {
      await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(asset.assetId)])
      const { rows: [existing] } = await db.query(`select id::text, asset_id as "assetId", kind, quote_spent::text as "quoteSpent"
        from stock_settlement_receipts where signature=$1`, [receipt.signature])
      if (existing) {
        await db.query('rollback')
        if (existing.assetId !== asset.assetId || existing.kind !== receipt.kind || existing.quoteSpent !== receipt.quoteSpent) throw Error('This signature is already recorded with other terms')
        return { status: 'already-recorded', id: existing.id }
      }
      const canonical = await activeCanonicalPool(db, asset.assetId)
      if (canonical?.pool !== receipt.evidence.pool) throw Error('The canonical pool changed since the receipt was verified')
      const { rows: [totals] } = await db.query(`select
        (select coalesce(sum(accumulator_amount),0) from stock_fee_collections where asset_id=$1 and status='settled')::text as collected,
        (select coalesce(sum(quote_spent),0) from stock_settlement_receipts where asset_id=$1)::text as spent`, [asset.assetId])
      const available = BigInt(totals.collected) - BigInt(totals.spent)
      if (BigInt(receipt.quoteSpent) > available) throw Error(`This transaction spends ${receipt.quoteSpent} raw ${asset.symbol} but only ${available} ` +
        'of collected accumulator funds are unspent; collect first (the owner\'s own funds are not an accumulator settlement)')
      // Again under the lock: the position's locked liquidity, as verified, must still cover every recorded deposit plus this one.
      for (const facts of receipt.evidence.positions ?? []) {
        const problem = lockCoverage(facts, await recordedLiquidity(db, asset.assetId, facts.address), receipt.evidence.liquidity?.[facts.address] ?? '0')
        if (problem) throw Error(problem)
      }
      const { rows: [row] } = await db.query(`insert into stock_settlement_receipts (asset_id, quote_mint, kind, signature, quote_spent, repoing_spent,
        repoing_received, evidence) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id::text`, [asset.assetId, asset.mint, receipt.kind, receipt.signature,
        receipt.quoteSpent, receipt.repoingSpent, receipt.repoingReceived, JSON.stringify(receipt.evidence)])
      await db.query('commit')
      return { status: 'recorded', id: row.id, availableBefore: text(available), availableAfter: text(available - BigInt(receipt.quoteSpent)) }
    } catch (error) { await db.query('rollback').catch(() => {}); throw error }
  } finally { db.release() }
}

export function describeSettlementReceipt(receipt, symbol) {
  const e = receipt.evidence
  const steps = { seed: 'created and seeded the pool', swap: `swapped ${symbol} into REPOING`, add_liquidity: 'added liquidity' }
  return [`Transaction ${receipt.signature} (slot ${e.slot}) by owner wallet ${e.owner} ${steps[receipt.kind]} on canonical pool ${e.pool}:`,
    `  spent ${receipt.quoteSpent} raw ${symbol} and ${receipt.repoingSpent} raw REPOING, received ${receipt.repoingReceived} raw REPOING;`,
    `  the owner's balances moved exactly ${e.deltas.stock.owner} ${symbol} and ${e.deltas.repoing.owner} REPOING, the pool's vaults the opposite.`,
    ...e.positions.map(p => `  position ${p.address}: ${p.liquidity.permanent} liquidity, all permanently locked.`)]
}
