// Synthetic production-ID ABI bytes. Only ephemeral local keys; never sent to a chain.
import { generateKeyPairSync, sign } from 'node:crypto'
import { Keypair, PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { accountBytes } from './hooklab-plain.mjs'
import { prepareCurveReview, curveDigest } from '../../src/hooklab-curve.mjs'

const programs = {
  launch: new PublicKey('E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft'),
  swap: new PublicKey('B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk'),
  token: new PublicKey('2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22'),
}
export function curveFixture({ side = 'buy', recipientSame = false, payerSame = false, unsignedOnly = false } = {}) {
  const trader = Keypair.generate(), payer = payerSame ? trader : Keypair.generate()
  const recipient = recipientSame ? trader : Keypair.generate(), mint = Keypair.generate().publicKey
  const quote = new PublicKey('A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i')
  const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds, program)[0]
  const holding = (m, o) => pda(programs.token, Buffer.from('holding'), m.toBuffer(), o.toBuffer())
  const launch = pda(programs.launch, Buffer.from('launch'), mint.toBuffer())
  const pool = pda(programs.swap, Buffer.from('pool'), mint.toBuffer(), quote.toBuffer(), Buffer.from([0, 0]), programs.launch.toBuffer())
  const lpMint = pda(programs.swap, Buffer.from('lp'), pool.toBuffer())
  const kit = pda(new PublicKey('AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm'), Buffer.from('kit'), mint.toBuffer())
  const addresses = { mint, quoteMint: quote, pool, launch, lpMint, kitConfig: kit, holderVault: holding(quote, kit),
    swapConfig: pda(programs.swap, Buffer.from('config')), baseVault: holding(mint, pool), quoteVault: holding(quote, pool),
    launchQuote: holding(quote, launch), launchReserve: holding(mint, launch), launchLp: holding(lpMint, launch),
    poolRegistry: pda(programs.launch, Buffer.from('bordrless-hook-accounts'), pool.toBuffer()),
    traderBase: holding(mint, side === 'buy' ? recipient.publicKey : trader.publicKey),
    traderQuote: holding(quote, side === 'buy' ? trader.publicKey : recipient.publicKey) }
  const intent = { schema: 'repoing/curve-intent/1', side, trader: trader.publicKey.toBase58(), recipient: recipient.publicKey.toBase58(),
    feePayer: payer.publicKey.toBase58(), mint: mint.toBase58(), amountIn: side === 'buy' ? '101' : '137',
    minAmountOut: side === 'buy' ? '660' : '19', maxInput: '200', maxPriceImpactBps: 100,
    maxNetworkFeeLamports: payerSame ? '5000' : '10000', computeUnitLimit: 400000, computeUnitPriceMicroLamports: '0' }
  const fields = {}, accounts = {}
  const define = (role, program, name, values, size) => {
    fields[role] = { program, name, values: { version: 1, ...values }, size }
    accounts[role] = { address: addresses[role].toBase58(), owner: programs[program].toBase58(), executable: false,
      dataBase64: accountBytes(program, name, fields[role].values, size).toString('base64') }
  }
  define('swapConfig', 'swap', 'Config', { admin: 'DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5',
    treasury: 'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i', fee_collector: 'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i' }, 189)
  define('pool', 'swap', 'Pool', { base_mint: mint, quote_mint: quote, lp_mint: lpMint, base_vault: addresses.baseVault,
    quote_vault: addresses.quoteVault, hook_program: programs.launch, hook_flags: 1985, base_reserve: 60000,
    quote_reserve: 9000, virtual_base: 20000, virtual_quote: 3000, curve: true, creator: launch,
    swap_count: 7, base_volume: 12345, quote_volume: 2345, protocol_fees_quote: 17, fee_model: 1 }, 411)
  define('launch', 'launch', 'Launch', { mint, creator: trader.publicKey, pool, quote_mint: quote,
    virtual_base: 20000, virtual_quote: 3000, graduation_quote: 50000, curve_tokens: 70000, reserve_tokens: 30000,
    reserve_holding: addresses.launchReserve, quote_holding: addresses.launchQuote, lp_holding: addresses.launchLp,
    kit_config: kit, holder_vault: addresses.holderVault }, 565)
  for (const role of ['mint', 'quoteMint']) define(role, 'token', 'Mint', { supply: 100000, max_supply: 100000, decimals: 6 }, 519)
  for (const [role, m, owner, amount] of [
    ['baseVault', mint, pool, 60000], ['quoteVault', quote, pool, 9017], ['launchQuote', quote, launch, 0],
    ['traderBase', mint, side === 'buy' ? recipient.publicKey : trader.publicKey, 1000],
    ['traderQuote', quote, side === 'buy' ? trader.publicKey : recipient.publicKey, 2000],
  ]) define(role, 'token', 'Holding', { mint: m, owner, amount }, 204)
  // Independently encoded Borsh registry from producer's canonical plain launch layout.
  const registry = Buffer.concat([Buffer.from('02daf6662c38c0cd01040000000101', 'hex'), programs.launch.toBuffer(),
    Buffer.from('0200000000060000006c61756e636801020101', 'hex'), programs.token.toBuffer(),
    Buffer.from('030000000007000000686f6c64696e67010301050100', 'hex'), addresses.holderVault.toBuffer(), Buffer.from([0, 0]), kit.toBuffer()])
  accounts.poolRegistry = { address: addresses.poolRegistry.toBase58(), owner: programs.launch.toBase58(), executable: false, dataBase64: registry.toString('base64') }
  const observed = { schema: 'repoing/curve-snapshot/1', genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    slot: 100, nowMs: 1000, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 160,
    networkFeeLamports: intent.maxNetworkFeeLamports, accounts }
  const plan = prepareCurveReview(intent, observed)
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64, 'base64')))
  const partial = signer => { const t = new VersionedTransaction(tx.message); t.sign([signer]); return Buffer.from(t.serialize()).toString('base64') }
  if (!unsignedOnly) tx.sign(payerSame ? [trader] : [trader, payer])
  const signed = Buffer.from(tx.serialize()).toString('base64')
  const patchAccount = (role, changes, target = accounts) => {
    const f = fields[role]
    target[role].dataBase64 = accountBytes(f.program, f.name, { ...f.values, ...changes }, f.size).toString('base64')
  }
  return { intent, observed, plan, addresses, fields, patchAccount, trader, payer, partial, signed, tx,
    current: { genesisHash: observed.genesisHash, wallet: intent.trader, profileSha256: plan.review.profileSha256,
      policySha256: plan.review.policySha256, slot: 101, blockHeight: 110, nowMs: 1500, blockhashValid: true,
      feeLamports: observed.networkFeeLamports, lookupTableHashes: [] } }
}

export function curveObservations(f) {
  const after = structuredClone(f.observed.accounts), buy = f.intent.side === 'buy'
  // Expected values calculated independently: floor(101*80000/12101)=667; floor(137*12000/80137)=20.
  f.patchAccount('pool', { base_reserve: buy ? 59333 : 60137, quote_reserve: buy ? 9101 : 8980, swap_count: 8,
    base_volume: buy ? 13012 : 12482, quote_volume: buy ? 2446 : 2365, last_swap_at: 2000 }, after)
  for (const [role, amount] of [['baseVault', buy ? 59333 : 60137], ['quoteVault', buy ? 9118 : 8997],
    ['traderBase', buy ? 1667 : 863], ['traderQuote', buy ? 1899 : 2020]]) f.patchAccount(role, { amount }, after)
  const signature = bs58.encode(f.tx.signatures[0])
  const receipt = { genesisHash: f.observed.genesisHash, signature, messageSha256: f.plan.review.messageSha256,
    signedTransactionBase64: f.signed, slot: 104, confirmationStatus: 'finalized', feeLamports: f.observed.networkFeeLamports,
    error: null, balances: f.plan.review.accounts.map(a => ({ address: a.address, before: '50000000',
      after: String(50000000n - (a.address === f.intent.feePayer ? BigInt(f.observed.networkFeeLamports) : 0n)) })) }
  const history = { schema: 'repoing/curve-history/1', kind: 'transaction-replay', signature, slot: 104,
    transactionIndex: 3, messageSha256: f.plan.review.messageSha256, evidenceSha256: 'a'.repeat(64),
    blockTime: 2000, before: f.observed.accounts, after }
  return ['alpha', 'beta'].map(provider => structuredClone({ provider, receipt, history }))
}

export function curveRpc(f) {
  const { receipt } = curveObservations(f)[0]
  return { getGenesisHash: async () => f.observed.genesisHash, getTransaction: async () => ({ slot: receipt.slot,
    transaction: { message: f.tx.message, signatures: f.tx.signatures.map(s => bs58.encode(s)) },
    meta: { err: null, fee: Number(receipt.feeLamports), preBalances: receipt.balances.map(b => Number(b.before)),
      postBalances: receipt.balances.map(b => Number(b.after)) } }),
    getMultipleAccountsInfoAndContext() { throw new Error('Later state must never be substituted for history') } }
}

export function curveArchive(f, patch = {}) {
  const { receipt, history } = curveObservations(f)[0]
  const payload = { schema: 'repoing/curve-archive-assertion/1', source: 'synthetic-archive',
    genesisHash: f.plan.review.genesisHash, profileSha256: f.plan.review.profileSha256, receipt, history, ...patch }
  const raw = Buffer.from(JSON.stringify(payload)), keys = generateKeyPairSync('ed25519')
  const envelope = { payloadBase64: raw.toString('base64'),
    signatureBase64: sign(null, Buffer.concat([Buffer.from('repo.ing curve archive assertion v1\n'), raw]), keys.privateKey).toString('base64') }
  return { payload, envelope, pins: { publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }),
    archiveSha256: curveDigest(raw), source: 'synthetic-archive' } }
}
