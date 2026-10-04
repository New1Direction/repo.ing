import bs58 from 'bs58'
import { Connection, Keypair, Message, PublicKey, Transaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { quoteAssetById } from '../../src/quote-assets.mjs'
import { collectionInstructions, stockCollectionTerms, stockCollectionTermsHash } from '../../src/stock-collections.mjs'
import { splitCurveFee } from '../../src/stock-fee-policy.mjs'

// Fakes for the stock execution tests (tests/stock-execution*.test.mjs): an in-process chain that records every send, a
// finalized transaction in the shape src/finalized-transaction.mjs returns, and collection previews built with PR-E's own
// builders (src/stock-collections.mjs), offline. Nothing here opens a network connection.

export const META = quoteAssetById('meta-xstock')
export const address = () => Keypair.generate().publicKey.toBase58()
export const LOCAL_GENESIS = 'LocalGenesis1111111111111111111111111111111'

// A legacy transaction as the RPC returns it at finalized (encoding json), normalized: account keys as PublicKeys.
export function finalizedTransaction(raw, meta = {}) {
  const tx = Transaction.from(raw), message = Message.from(tx.serializeMessage())
  const keys = message.accountKeys
  return { slot: 4242, blockTime: 1_790_000_000, version: 'legacy',
    transaction: { signatures: tx.signatures.map(s => bs58.encode(s.signature)), message: { header: message.header, accountKeys: keys,
      recentBlockhash: message.recentBlockhash, instructions: message.instructions.map(ix => ({ ...ix, stackHeight: null })) } },
    meta: { err: null, fee: 25_000, preBalances: keys.map(() => 1_000_000_000), postBalances: keys.map(() => 1_000_000_000),
      preTokenBalances: [], postTokenBalances: [], innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, ...meta } }
}

const tokenBalance = (accountIndex, amount, owner, mint = META.mint) => ({ accountIndex, mint, owner, programId: TOKEN_2022_PROGRAM_ID.toBase58(),
  uiTokenAmount: { amount: String(amount), decimals: META.decimals, uiAmount: null, uiAmountString: String(amount) } })

// The finalized collection a correct claim leaves: the pool's stock vault −received, custody's stock account +received (created
// by the claim's idempotent instruction, so it has no balance before).
export function collectionTransaction(raw, terms, received = BigInt(terms.amount)) {
  const base = finalizedTransaction(raw)
  const keys = base.transaction.message.accountKeys.map(k => k.toBase58())
  const vault = keys.indexOf(terms.sourceVault), custody = keys.indexOf(terms.receiverTokenAccount), held = 10n ** 12n
  return { ...base, meta: { ...base.meta, preTokenBalances: [tokenBalance(vault, held, terms.pool)],
    postTokenBalances: [tokenBalance(vault, held - BigInt(received), terms.pool), tokenBalance(custody, received, terms.receiver)] } }
}

// Rent-exempt lamports for an account of `bytes`, as the fake chain answers getMinimumBalanceForRentExemption.
export const rentFor = bytes => (bytes + 128) * 6960
// What the payouts' mint check returns for a stock mint with no account-adding extensions: Token-2022 creates its accounts at
// 170 bytes (ImmutableOwner), so their rent is rentFor(170).
export const usableMint = async () => ({ ok: true, mint: { tlvData: Buffer.alloc(0) } })
export const ACCOUNT_RENT = rentFor(170)

// The finalized payout a correct transfer leaves: custody −amount, the launcher +amount (its account created when `created`),
// the network fee and that account's rent from custody, nothing else. prefunded: lamports someone sent to the launcher's account
// address before it existed; the account program then takes only the rest of the rent from custody.
export function payoutTransaction(raw, terms, { created = true, fee = 25_000, rent = ACCOUNT_RENT, prefunded = 0, custodyBefore = 50_000_000n } = {}) {
  const base = finalizedTransaction(raw)
  const keys = base.transaction.message.accountKeys.map(k => k.toBase58())
  const wallet = keys.indexOf(terms.walletTokenAccount), custody = keys.indexOf(terms.custodyTokenAccount), amount = BigInt(terms.amount)
  const pre = keys.map((_, i) => (created && i === wallet ? prefunded : 1_000_000_000))
  const post = pre.map((value, i) => (i === 0 ? value - fee - (created ? rent - prefunded : 0) : created && i === wallet ? rent : value))
  const ata = base.transaction.message.instructions.findIndex(ix => keys[ix.programIdIndex] === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())
  return { ...base, meta: { ...base.meta, fee, preBalances: pre, postBalances: post,
    preTokenBalances: [tokenBalance(custody, custodyBefore, terms.custody), ...(created ? [] : [tokenBalance(wallet, 0n, terms.wallet)])],
    postTokenBalances: [tokenBalance(custody, custodyBefore - amount, terms.custody), tokenBalance(wallet, amount, terms.wallet)],
    innerInstructions: created ? [{ index: ata, instructions: [] }] : [] } }
}

// A finalized read on whichever fake chain the connection belongs to (a second chain stands in for the verification RPC).
export const loadFrom = async (rpc, signature) => rpc?._chain?.landed.get(signature) ?? null

// A chain in one process. Sent bytes land (finalized) unless `landing` says otherwise ('known': an RPC knows the signature but it
// is not finalized; 'none': dropped); `finalized(raw, signature)` builds what a finalized read returns. Every send is kept, with
// its bytes, in order. custodyBalance is custody's stock balance, for the payouts' custody gate.
export function fakeChain({ finalized = raw => finalizedTransaction(raw), genesis = LOCAL_GENESIS, endpoint = 'http://127.0.0.1:8899' } = {}) {
  const chain = { height: 10_000, finalizedHeight: 10_000, sends: [], calls: [], landed: new Map(), known: new Set(),
    landing: 'finalized', refuseSends: false, custodyBalance: 50_000_000n, finalized }
  const land = raw => {
    const signature = bs58.encode(Transaction.from(raw).signature)
    if (chain.landing === 'finalized') chain.landed.set(signature, chain.finalized(raw, signature))
    else if (chain.landing === 'known') chain.known.add(signature)
    return signature
  }
  const rpc = (name, fn) => async (...args) => { chain.calls.push(name); return fn(...args) }
  chain.connection = {
    rpcEndpoint: endpoint,
    getGenesisHash: rpc('getGenesisHash', () => genesis),
    getLatestBlockhash: rpc('getLatestBlockhash', () => ({ blockhash: address(), lastValidBlockHeight: chain.height + 150 })),
    getRecentPrioritizationFees: rpc('getRecentPrioritizationFees', () => []),
    simulateTransaction: rpc('simulateTransaction', () => ({ value: { err: null, unitsConsumed: 60_000, logs: [] } })),
    getFeeForMessage: rpc('getFeeForMessage', () => ({ value: 25_000 })),
    getBlockHeight: rpc('getBlockHeight', commitment => (commitment === 'finalized' ? chain.finalizedHeight : chain.height)),
    getMinimumBalanceForRentExemption: rpc('getMinimumBalanceForRentExemption', bytes => rentFor(bytes)),
    sendRawTransaction: rpc('sendRawTransaction', raw => {
      const bytes = Buffer.from(raw)
      chain.sends.push(bytes.toString('base64'))
      if (chain.refuseSends) throw Error('Transaction simulation failed: Blockhash not found')
      return land(bytes)
    }),
    getSignatureStatuses: rpc('getSignatureStatuses', ([signature]) => {
      const finalTx = chain.landed.get(signature)
      if (finalTx) return { value: [{ slot: 4242, confirmations: null, err: finalTx.meta.err, confirmationStatus: 'finalized' }] }
      return { value: [chain.known.has(signature) ? { slot: 4242, confirmations: 1, err: null, confirmationStatus: 'confirmed' } : null] }
    }),
  }
  chain.connection._chain = chain
  chain.loadTransaction = loadFrom
  // A deterministic clock for broadcastUntilSettled and the finality wait: each sleep advances it.
  let now = 0
  chain.follow = { now: () => now, sleep: async ms => { now += ms } }
  return chain
}

const offline = () => new Connection('http://127.0.0.1:1', 'finalized')
export const offlinePrograms = () => ({ dbc: new DynamicBondingCurveClient(offline(), 'finalized').state.getProgram(), amm: new CpAmm(offline()) })

// A stock-paired market row as listStockMarkets returns it.
export function stockMarket(overrides = {}) {
  return { repoId: '94911145', mint: address(), pool: address(), creatorWallet: address(), launcherWallet: Keypair.generate().publicKey.toBase58(),
    quoteAssetId: META.assetId, quoteMint: META.mint, quoteRegistryVersion: 1, fullName: 'facebook/docusaurus', dammPool: null,
    creatorPosition: null, partnerPosition: null, ...overrides }
}

// previewMarket's result for a curve source that MATCHes, built exactly as src/stock-collections.mjs builds it.
export async function curvePreview({ market, source, signer, custody, creatorFee = 10_000_000n, partnerFee = 4_000_000n, dbc = null }) {
  const d = dbc ?? { pool: market.pool, config: address(), baseVault: address(), quoteVault: address() }
  const split = splitCurveFee({ creatorAmount: creatorFee, partnerAmount: partnerFee })
  const amount = source === 'dbc_creator' ? creatorFee : partnerFee
  const launcherAmount = source === 'dbc_creator' ? split.launcherAmount : 0n
  const evaluation = { source, onchain: String(amount), ledgerExpected: String(amount), earned: String(amount), collected: '0',
    launcherEarned: String(launcherAmount), launcherCollected: '0', status: 'MATCH', amount: String(amount), launcherAmount: String(launcherAmount),
    accumulatorAmount: String(amount - launcherAmount) }
  const built = await collectionInstructions({ source, signer, custody, market, quoteMint: META.mint, amount: String(amount), dbc: d, programs: offlinePrograms() })
  const terms = stockCollectionTerms({ market, asset: META, source, evaluation, signer, custody, built, sourceVault: d.quoteVault, pool: d.pool, config: d.config })
  return { ...evaluation, signer, receiver: custody, receiverTokenAccount: built.receiverTokenAccount, instructions: built.instructions, terms,
    termsHash: stockCollectionTermsHash(terms) }
}

// previewMarket's result for a graduated position (damm_creator or damm_partner) that MATCHes, as src/stock-collections.mjs
// builds it: the position has earned `earned` in all and nothing was collected from it yet.
export async function dammPreview({ market, source = 'damm_creator', signer, custody, earned = 20_000_000n, damm = null }) {
  const d = damm ?? { pool: address(), tokenAVault: address(), tokenBVault: address(),
    creator: { position: address(), nftAccount: address() }, partner: { position: address(), nftAccount: address() } }
  const launcherAmount = source === 'damm_creator' ? earned * 150n / 497n : 0n
  const evaluation = { source, onchain: String(earned), ledgerExpected: String(earned), earned: String(earned), collected: '0',
    launcherEarned: String(launcherAmount), launcherCollected: '0', status: 'MATCH', amount: String(earned), launcherAmount: String(launcherAmount),
    accumulatorAmount: String(earned - launcherAmount) }
  const built = await collectionInstructions({ source, signer, custody, market, quoteMint: META.mint, amount: String(earned), damm: d, programs: offlinePrograms() })
  const side = source === 'damm_creator' ? d.creator : d.partner
  const terms = stockCollectionTerms({ market, asset: META, source, evaluation, signer, custody, built, sourceVault: d.tokenBVault, pool: d.pool,
    position: side.position })
  return { ...evaluation, signer, receiver: custody, receiverTokenAccount: built.receiverTokenAccount, instructions: built.instructions, terms,
    termsHash: stockCollectionTermsHash(terms) }
}

export const previewOf = (market, sources) => ({ repoId: market.repoId, fullName: market.fullName, mint: market.mint, assetId: market.quoteAssetId,
  status: sources.some(s => s.status === 'MATCH') ? 'COLLECTABLE' : 'NOTHING', slot: 4242, uncollected: '0', graduated: false, sources })

// The receipt checkStockCollectionReceipt returns for a curve collection of exactly the reviewed amount.
export const curveReceipt = (terms, signature) => ({ source: terms.source, signature, slot: 4242, amount: terms.amount, reviewed: terms.amount,
  excess: '0', receiver: terms.receiver, receiverTokenAccount: terms.receiverTokenAccount, networkFee: '25000' })

export { PublicKey }
