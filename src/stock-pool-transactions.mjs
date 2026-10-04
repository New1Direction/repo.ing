import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CP_AMM_PROGRAM_ID, CpAmm } from '@meteora-ag/cp-amm-sdk'
import { programEvents, tokenDeltas } from './stock-collections.mjs'

// What an owner's finalized transaction did on a canonical REPOING/<stock> DAMM v2 pool (docs/STOCK_QUOTES.md, "Accumulator
// and settlement"), read from the program's own events and the exact token balance deltas. Pure. Shared by the pool registry
// (the pool's creation must be an owner wallet's seed) and settlement receipts.

export const SETTLEMENT_KINDS = Object.freeze(['seed', 'swap', 'add_liquidity'])
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const PLAIN_PROGRAMS = [ComputeBudgetProgram.programId, SystemProgram.programId, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID, CP_AMM_PROGRAM_ID, MEMO_PROGRAM]
const KNOWN_EVENTS = ['evtswap2', 'evtliquiditychange', 'evtinitializepool', 'evtcreateposition', 'evtpermanentlockposition']
const text = value => value.toString()
const amountOf = value => BigInt(text(value))
let offlineCoder
const ammEvents = () => (offlineCoder ??= new CpAmm(new Connection('http://127.0.0.1:1', 'finalized'))._program.coder.events)
const keysOf = transaction => transaction.transaction.message.accountKeys.map(k => (k instanceof PublicKey ? k : new PublicKey(k)))

// canonical: { pool, repoingMint, evidence: { pool: { sides, tokenAVault, tokenBVault } } } (a stock_canonical_pools row, or the
// facts verifyCanonicalPool read); owners: the owner wallets. Throws on anything that is not exactly one settlement step of
// `kind` paid for by an owner wallet on that pool:
//   seed           the pool's creation (EvtInitializePool), its creator and payer owner wallets, no swap or other deposit;
//   swap           one swap of the stock into REPOING;
//   add_liquidity  one owner deposit, after at most one such swap.
// Only plain programs may run, every DAMM v2 event must be the pool's own, and the stock and REPOING balance deltas must be
// exactly the owner's spend and receipt mirrored by the pool's vaults, with no other account of either mint moving. Each
// position deposited into is returned with the liquidity this transaction added to it.
export function analyzeSettlementTransaction({ transaction, kind, asset, canonical, owners }) {
  if (!SETTLEMENT_KINDS.includes(kind)) throw Error(`kind must be one of ${SETTLEMENT_KINDS.join(', ')}`)
  if (!Array.isArray(owners) || !owners.length) throw Error('Owner wallets are required')
  if (!transaction?.meta) throw Error('The transaction is not finalized yet')
  if (transaction.meta.err) throw Error('The transaction failed on chain')
  const keys = keysOf(transaction), owner = keys[0]?.toBase58()
  if (!owners.includes(owner)) throw Error(`The transaction was paid for by ${owner}, not an owner wallet`)
  for (const ix of transaction.transaction.message.instructions) {
    const program = keys[ix.programIdIndex]
    if (!PLAIN_PROGRAMS.some(p => p.equals(program))) throw Error(`The transaction also runs ${program?.toBase58()}; record only plain settlement steps`)
  }
  const pool = canonical.pool, sides = canonical.evidence?.pool?.sides
  const vault = side => canonical.evidence.pool[side === 'A' ? 'tokenAVault' : 'tokenBVault']
  if (!sides || !vault('A') || !vault('B')) throw Error('The canonical pool record has no verified sides; register it again')
  const events = programEvents(transaction, CP_AMM_PROGRAM_ID, ammEvents())
  for (const event of events) if (event.data.pool && event.data.pool.toBase58() !== pool) throw Error('The transaction touches another DAMM v2 pool')
  const unexpected = events.filter(e => !KNOWN_EVENTS.includes(e.name))
  if (unexpected.length) throw Error(`The transaction also does ${unexpected.map(e => e.name).join(', ')} on the pool`)
  const of = name => events.filter(e => e.name === name)
  const swaps = of('evtswap2'), changes = of('evtliquiditychange'), inits = of('evtinitializepool')
  const shape = { swap: [1, 0, 0], add_liquidity: [null, 1, 0], seed: [0, 0, 1] }[kind]
  if ((shape[0] !== null && swaps.length !== shape[0]) || swaps.length > 1 || changes.length !== shape[1] || inits.length !== shape[2])
    throw Error(`A ${kind} receipt needs ${kind === 'swap' ? 'exactly one swap' : kind === 'seed' ? 'exactly one pool creation' : 'exactly one deposit, after at most one swap'}`)
  // The stock into REPOING only: trade_direction 0 is A to B.
  const swap = swaps[0]?.data ?? null
  if (swap && swap.tradeDirection !== (sides.stock === 'A' ? 0 : 1)) throw Error(`The swap sells REPOING for ${asset.symbol}; a settlement only buys REPOING`)
  // Event fields as the IDL coder names them: transfer_fee_included_token_a_amount, total_amount_a.
  const deposited = (data, letter) => amountOf(data[`transferFeeIncludedToken${letter}Amount`])
  const seeded = (data, letter) => amountOf(data[`totalAmount${letter}`])
  let stockDeposit = 0n, repoingDeposit = 0n
  const liquidity = {}
  if (kind === 'add_liquidity') {
    const change = changes[0].data
    if (change.changeType !== 0 || !owners.includes(change.owner.toBase58())) throw Error('The deposit is not an owner wallet adding liquidity')
    stockDeposit = deposited(change, sides.stock); repoingDeposit = deposited(change, sides.repoing)
    liquidity[change.position.toBase58()] = text(change.liquidityDelta)
  }
  if (kind === 'seed') {
    const init = inits[0].data, created = of('evtcreateposition')
    // The creator receives the position NFT but need not sign; the payer signs and funds the pool. Both must be owner wallets.
    if (!owners.includes(init.creator.toBase58()) || !owners.includes(init.payer.toBase58())) throw Error('The pool was not created and paid for by owner wallets')
    if (created.length !== 1) throw Error('The pool creation must create exactly one position')
    stockDeposit = seeded(init, sides.stock); repoingDeposit = seeded(init, sides.repoing)
    liquidity[created[0].data.position.toBase58()] = text(init.liquidity)
  }
  const swapIn = swap ? amountOf(swap.includedTransferFeeAmountIn) : 0n, swapOut = swap ? amountOf(swap.excludedTransferFeeAmountOut) : 0n
  const quoteSpent = swapIn + stockDeposit, repoingSpent = repoingDeposit, repoingReceived = swapOut
  if (quoteSpent <= 0n) throw Error(`The transaction spends no ${asset.symbol}`)
  const exact = (mint, ownerDelta, vaultAddress, label) => {
    const deltas = tokenDeltas(transaction, mint)
    let net = 0n
    for (const [address, entry] of deltas) {
      if (address === vaultAddress) { if (entry.delta !== -ownerDelta) throw Error(`The pool's ${label} vault moved ${entry.delta}, not ${-ownerDelta}`); continue }
      if (entry.owner === owner) { net += entry.delta; continue }
      if (entry.delta !== 0n) throw Error(`Another ${label} account moved: ${address}`)
    }
    if (net !== ownerDelta) throw Error(`The owner's ${label} balance moved ${net}, not ${ownerDelta}`)
    if (ownerDelta !== 0n && deltas.get(vaultAddress)?.delta !== -ownerDelta) throw Error(`The pool's ${label} vault balance evidence is missing`)
    return { owner: text(net), vault: text(-net) }
  }
  const deltas = { stock: exact(asset.mint, -quoteSpent, vault(sides.stock), asset.symbol),
    repoing: exact(canonical.repoingMint, repoingReceived - repoingSpent, vault(sides.repoing), 'REPOING') }
  return { kind, owner, quoteSpent, repoingSpent, repoingReceived, positions: Object.keys(liquidity), liquidity, deltas,
    events: events.map(e => e.name), swap: swap && { amountIn: text(swapIn), amountOut: text(swapOut) },
    deposit: kind === 'swap' ? null : { stock: text(stockDeposit), repoing: text(repoingDeposit) } }
}

// Liquidity counts as permanent only while the position holds none unlocked or vesting, and its permanently locked liquidity
// covers every deposit recorded into it plus this one (permanent liquidity never decreases, so a deposit later withdrawn
// before it was locked can never be counted).
export function lockCoverage(facts, recorded, added) {
  const permanent = BigInt(facts.liquidity.permanent), required = BigInt(recorded) + BigInt(added)
  if (!facts.fullyLocked) return `Position ${facts.address} still holds ${facts.liquidity.unlocked} unlocked and ${facts.liquidity.vested} vesting liquidity; lock it permanently, then verify again`
  if (permanent < required) return `Position ${facts.address} has ${permanent} permanently locked liquidity, less than the ${required} recorded into it with this deposit`
  return null
}
