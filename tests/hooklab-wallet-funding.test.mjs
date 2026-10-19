// Customer wallet funding: add SOL to Hook Lab (create holdings + wrap) and withdraw it (unwrap). Synthetic accounts are
// encoded with the pinned production codecs; the bridge program uses a synthetic ELF through the test-only bridge pin.
// (Real-chain proof: the same compiler's transactions simulate cleanly on mainnet; see docs in the PR.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import BN from 'bn.js'
import { compileWalletFundingReview, walletFundingInventory, BRIDGE_PIN, HOLDING_BYTES } from '../src/hooklab-wallet-funding.mjs'
import { walletFundingResolver } from '../src/hooklab-wallet-funding-resolver.mjs'
import { loadArtifacts } from '../src/hooklab-owner-driver/artifacts.mjs'
import { PROGRAMS, QUOTE_MINT, MAINNET_GENESIS, LOADER, SYSTEM, derivedAddresses, holdingAddress, pda, kb } from '../src/hooklab-owner-driver/pins.mjs'

const sha = b => createHash('sha256').update(b).digest('hex')
const { coders } = loadArtifacts(), d = derivedAddresses(PROGRAMS, QUOTE_MINT)
const owner = Keypair.fromSeed(createHash('sha256').update('WALLET FUNDING TEST FIXTURE ONLY').digest())
const OWNER = owner.publicKey.toBase58(), COIN = '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn'
const elf = Buffer.alloc(64, 0x42), pin = { ...BRIDGE_PIN, elfLength: elf.length, elfSha256: sha(elf) }
const profile = { genesisHash: MAINNET_GENESIS, programs: PROGRAMS, quoteMint: QUOTE_MINT, profileSha256: 'a'.repeat(64), providers: ['helius', 'solana-labs'] }
const RENT = { holdingLamports: '1686560', walletLamports: '890880', vaultLamports: '890880' }
const acct = (address, owner, data, lamports = '1000000', executable = false) => ({ address, owner, executable, lamports, dataBase64: Buffer.from(data).toString('base64') })
const holdingBytes = (mint, who, amount, tamper = null) => {
  const b = Buffer.alloc(HOLDING_BYTES); createHash('sha256').update('account:Holding').digest().copy(b, 0, 0, 8); b[8] = 1
  b[9] = PublicKey.findProgramAddressSync([Buffer.from('holding'), kb(mint), kb(who)], new PublicKey(PROGRAMS.token))[1]
  kb(mint).copy(b, 10); kb(who).copy(b, 42); b.writeBigUInt64LE(BigInt(amount), 74); if (tamper) tamper(b); return b
}
const quoteMintBytes = Buffer.from(readFileSync(new URL('./fixtures/hooklab-quote-mint-mainnet.b64', import.meta.url), 'utf8'), 'base64')
const mintWith = patch => { const v = { ...coders.token.accounts.decode('Mint', quoteMintBytes), ...patch }; const body = Buffer.concat([quoteMintBytes.subarray(0, 8), coders.token.types.encode('Mint', v)]); return Buffer.concat([body, Buffer.alloc(519 - body.length)]) }
const coinBytes = mintWith({ decimals: 6, name: 'Hook Lab Canary', symbol: 'HLCANARY', mint_authority: null, hook_program: new PublicKey(PROGRAMS.gate), hook_flags: 1 })
const bridgeAccount = (name, value) => Buffer.concat([Buffer.from(loadArtifacts().idls.bridge.accounts.find(a => a.name === name).discriminator), coders.bridge.types.encode(name, value)])
const config = patch => bridgeAccount('Config', { version: 1, bump: 250, admin: new PublicKey(pin.upgradeAuthority), paused: false, wrappers: new BN(2), reserved: Array(32).fill(0), ...patch })
const wrapper = patch => bridgeAccount('Wrapper', { version: 1, bump: 255, wrapped_mint_bump: 254, native: true, underlying_mint: new PublicKey('So11111111111111111111111111111111111111112'),
  underlying_program: new PublicKey(SYSTEM), wrapped_mint: new PublicKey(QUOTE_MINT), vault: new PublicKey(d.bridgeSolVault), decimals: 9, total_wrapped: new BN(17000000000),
  registered_at: new BN(1760000000), registrar: new PublicKey(pin.upgradeAuthority), reserved: Array(32).fill(0), ...patch })
const programDataBytes = (authority = pin.upgradeAuthority, code = elf) => { const b = Buffer.alloc(45 + code.length + 8); b.writeUInt32LE(3, 0); b[12] = 1; kb(authority).copy(b, 13); code.copy(b, 45); return b }
const programBytes = () => { const b = Buffer.alloc(36); b.writeUInt32LE(2, 0); kb(pin.programData).copy(b, 4); return b }

function state({ walletLamports = '1000000000', quoteHolding = null, coinHolding = null, edit = {} } = {}) {
  const rows = {
    [OWNER]: acct(OWNER, SYSTEM, Buffer.alloc(0), walletLamports),
    [holdingAddress(QUOTE_MINT, OWNER)]: quoteHolding === null ? null : acct(holdingAddress(QUOTE_MINT, OWNER), PROGRAMS.token, quoteHolding),
    [COIN]: acct(COIN, PROGRAMS.token, coinBytes), [holdingAddress(COIN, OWNER)]: coinHolding === null ? null : acct(holdingAddress(COIN, OWNER), PROGRAMS.token, coinHolding),
    [PROGRAMS.bridge]: acct(PROGRAMS.bridge, LOADER, programBytes(), '1141440', true), [pin.programData]: acct(pin.programData, LOADER, programDataBytes()),
    [d.bridgeConfig]: acct(d.bridgeConfig, PROGRAMS.bridge, config()), [d.bridgeNativeWrapper]: acct(d.bridgeNativeWrapper, PROGRAMS.bridge, wrapper()),
    [d.bridgeSolVault]: acct(d.bridgeSolVault, SYSTEM, Buffer.alloc(0), '17000900880'), [QUOTE_MINT]: acct(QUOTE_MINT, PROGRAMS.token, quoteMintBytes),
    [PROGRAMS.token]: acct(PROGRAMS.token, LOADER, programBytes(), '1141440', true), [pda(LOADER, kb(PROGRAMS.token))]: acct(pda(LOADER, kb(PROGRAMS.token)), LOADER, Buffer.alloc(8)),
    ...edit,
  }
  return rows
}
const NOW = 1_800_000_000_000
const compile = (request, rows, extra = {}) => {
  const inventory = walletFundingInventory(profile, { schema: 'repoing/hooklab-wallet-funding-request/1', ...request }, pin)
  const accounts = inventory.map(address => ({ address, account: rows[address] ?? null }))
  return compileWalletFundingReview({ profile, bridgePin: pin, rent: RENT, request: { schema: 'repoing/hooklab-wallet-funding-request/1', ...request },
    observations: profile.providers.map(provider => ({ provider, genesisHash: MAINNET_GENESIS, commitment: 'finalized', slot: 1000, observedAtMs: NOW, accounts })),
    recentBlockhash: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1150, currentBlockHeight: 1000, observedSlot: 1000, observedAtMs: NOW,
      genesisHash: MAINNET_GENESIS, providers: profile.providers, lamportsPerSignature: '5000', networkFeeLamports: '7000' },
    limits: { nowMs: NOW, maxAgeMs: 60000, maxSlotLag: 150, validUntilSlot: 1032, reviewExpiresAtMs: NOW + 59000, computeUnitPriceMicroLamports: '10000', maxNetworkFeeLamports: '29000' }, ...extra })
}
const fund = (lamports, mint = COIN) => ({ action: 'fund', owner: OWNER, mint, lamports })
const withdraw = lamports => ({ action: 'withdraw', owner: OWNER, mint: null, lamports })

test('a fresh wallet adds SOL: both holdings are created, then exactly the requested SOL is wrapped', () => {
  const plan = compile(fund('1000000'), state())
  assert.equal(plan.review.operation, 'hooklab-wallet-fund')
  assert.deepEqual(plan.quote.createdHoldings, [holdingAddress(QUOTE_MINT, OWNER), holdingAddress(COIN, OWNER)])
  assert.equal(plan.review.instructionDebitLamports, String(2 * 1686560 + 1000000))
  assert.equal(plan.review.maxNativeDebitLamports, String(2 * 1686560 + 1000000 + 7000))
  assert.deepEqual(plan.instructions.map(ix => ix.program), ['ComputeBudget111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', PROGRAMS.token, PROGRAMS.token, PROGRAMS.bridge])
  assert.deepEqual(plan.review.requiredSigners, [OWNER])
})

test('existing holdings are reused; nothing to do is refused', () => {
  const rows = state({ quoteHolding: holdingBytes(QUOTE_MINT, OWNER, 5), coinHolding: holdingBytes(COIN, OWNER, 0) })
  const plan = compile(fund('2500'), rows)
  assert.deepEqual(plan.quote.createdHoldings, []); assert.equal(plan.review.instructionDebitLamports, '2500'); assert.equal(plan.quote.quoteBalanceAfter, '2505')
  assert.throws(() => compile(fund('0'), rows), /Nothing to add/)
  assert.equal(compile(fund('0'), state({ quoteHolding: holdingBytes(QUOTE_MINT, OWNER, 5) })).quote.createdHoldings.length, 1, 'only the coin holding')
})

test('withdraw unwraps at most the bridged SOL balance and debits only the network fee', () => {
  const rows = state({ quoteHolding: holdingBytes(QUOTE_MINT, OWNER, 2_000_000) })
  const plan = compile(withdraw('2000000'), rows)
  assert.equal(plan.review.operation, 'hooklab-wallet-withdraw'); assert.equal(plan.review.instructionDebitLamports, '0'); assert.equal(plan.review.maxNativeDebitLamports, '7000')
  assert.equal(plan.quote.walletLamportsAfter, String(1_000_000_000 - 7000 + 2_000_000))
  assert.throws(() => compile(withdraw('2000001'), rows), /at most your SOL in Hook Lab/)
  assert.throws(() => compile(withdraw('1'), state()), /at most your SOL in Hook Lab/, 'no holding at all')
  assert.throws(() => compile(withdraw('1'), state({ quoteHolding: holdingBytes(QUOTE_MINT, OWNER, 5), edit: { [d.bridgeSolVault]: acct(d.bridgeSolVault, SYSTEM, Buffer.alloc(0), '890880') } })), /cannot pay this out/)
})

test('a changed or paused bridge, wrapper or bridged-SOL mint is refused', () => {
  const base = state()
  for (const [label, edit, message] of [
    ['bridge code', { [pin.programData]: acct(pin.programData, LOADER, programDataBytes(pin.upgradeAuthority, Buffer.alloc(64, 0x43))) }, /Bridge code or upgrade authority/],
    ['upgrade authority', { [pin.programData]: acct(pin.programData, LOADER, programDataBytes(OWNER)) }, /Bridge code or upgrade authority/],
    ['bridge paused', { [d.bridgeConfig]: acct(d.bridgeConfig, PROGRAMS.bridge, config({ paused: true })) }, /paused by the bridge/],
    ['wrapper mint', { [d.bridgeNativeWrapper]: acct(d.bridgeNativeWrapper, PROGRAMS.bridge, wrapper({ wrapped_mint: new PublicKey(COIN) })) }, /wrapper differs/],
    ['wrapper vault', { [d.bridgeNativeWrapper]: acct(d.bridgeNativeWrapper, PROGRAMS.bridge, wrapper({ vault: new PublicKey(OWNER) })) }, /wrapper differs/],
    ['quote mint authority', { [QUOTE_MINT]: acct(QUOTE_MINT, PROGRAMS.token, mintWith({ mint_authority: new PublicKey(OWNER) })) }, /Bridged SOL mint differs/],
    ['quote mint freeze', { [QUOTE_MINT]: acct(QUOTE_MINT, PROGRAMS.token, mintWith({ freeze_authority: new PublicKey(OWNER) })) }, /Bridged SOL mint differs/],
  ]) assert.throws(() => compile(fund('1000'), { ...base, ...edit }), message, label)
  // An under-backed bridge takes no deposits, and still pays withdrawals.
  const short = { [d.bridgeSolVault]: acct(d.bridgeSolVault, SYSTEM, Buffer.alloc(0), '17000890879') }
  assert.throws(() => compile(fund('1000'), { ...base, ...short }), /unavailable right now/)
  assert.equal(compile(withdraw('10'), state({ quoteHolding: holdingBytes(QUOTE_MINT, OWNER, 10), edit: short })).review.operation, 'hooklab-wallet-withdraw')
  // A paused bridge still lets people withdraw.
  const paused = state({ quoteHolding: holdingBytes(QUOTE_MINT, OWNER, 10), edit: { [d.bridgeConfig]: acct(d.bridgeConfig, PROGRAMS.bridge, config({ paused: true })) } })
  assert.equal(compile(withdraw('10'), paused).review.operation, 'hooklab-wallet-withdraw')
})

test('only regular wallets, real Hooks coins and canonical holdings are accepted', () => {
  assert.throws(() => compile(fund('1000'), state({ edit: { [OWNER]: acct(OWNER, SYSTEM, Buffer.alloc(1), '1000000000') } })), /regular wallet/)
  assert.throws(() => compile(fund('1000'), state({ edit: { [COIN]: acct(COIN, PROGRAMS.token, mintWith({ decimals: 6, mint_authority: null })) } })), /Not a Hooks coin/)
  assert.throws(() => compile(fund('1000', QUOTE_MINT), state()), /request shape/)
  assert.throws(() => compile(fund('1000'), state({ quoteHolding: holdingBytes(QUOTE_MINT, OWNER, 5, b => { b[90] = 1 }) })), /canonical, undelegated/)
  assert.throws(() => compile(fund('1000'), state({ coinHolding: holdingBytes(COIN, OWNER, 5, b => { b[9] ^= 1 }) })), /canonical, undelegated/)
  assert.throws(() => compile(fund('999000000'), state()), /keep about 0.001 SOL/)
  assert.throws(() => compile({ action: 'withdraw', owner: OWNER, mint: COIN, lamports: '1' }, state()), /request shape/)
})

test('observations must come from both providers, agree and be fresh', () => {
  const rows = state(), request = { schema: 'repoing/hooklab-wallet-funding-request/1', ...fund('1000') }
  const accounts = walletFundingInventory(profile, request, pin).map(address => ({ address, account: rows[address] ?? null }))
  const observation = (provider, list = accounts, extra = {}) => ({ provider, genesisHash: MAINNET_GENESIS, commitment: 'finalized', slot: 1000, observedAtMs: NOW, accounts: list, ...extra })
  const other = accounts.map(x => x.address === OWNER ? { ...x, account: { ...x.account, lamports: '1' } } : x)
  for (const [label, observations, message] of [
    ['disagree', [observation('helius'), observation('solana-labs', other)], /disagree/], ['same provider', [observation('helius'), observation('helius')], /independent/],
    ['wrong chain', [observation('helius', accounts, { genesisHash: OWNER }), observation('solana-labs', accounts, { genesisHash: OWNER })], /wrong-chain/],
    ['stale', [observation('helius', accounts, { observedAtMs: NOW - 120000 }), observation('solana-labs', accounts, { observedAtMs: NOW - 120000 })], /Stale/],
    ['missing row', [observation('helius', accounts.slice(1)), observation('solana-labs', accounts.slice(1))], /inventory/],
  ]) assert.throws(() => compile(fund('1000'), rows, { observations }), message, label)
})

// Resolver: fake two-provider chain, a really signed transaction, and receipts with exact or wrong lamport movements.
function chain({ rows, receipt = null, blockHeight = 1100, simulated = () => null }) {
  return {
    rpcEndpoint: '', getGenesisHash: async () => MAINNET_GENESIS,
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: 1000 }, value: keys.map(k => { const a = rows[k.toBase58()]; return a ? { owner: new PublicKey(a.owner), executable: a.executable, lamports: Number(a.lamports), data: Buffer.from(a.dataBase64, 'base64') } : null }) }),
    getMinimumBalanceForRentExemption: async bytes => bytes === HOLDING_BYTES ? 1686560 : 890880,
    getLatestBlockhashAndContext: async () => ({ context: { slot: 1000 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1150 } }),
    isBlockhashValid: async () => ({ context: { slot: 1000 }, value: true }), getBlockHeight: async () => 1000, getSlot: async () => 1000,
    getFeeForMessage: async () => ({ context: { slot: 1000 }, value: 7000 }),
    simulateTransaction: async (_tx, options) => ({ context: { slot: 1000 }, value: { err: null, accounts: options.accounts?.addresses.map(address => ({ lamports: simulated(address) })) ?? null } }),
    getTransaction: async () => receipt, getBlockSignatures: async () => ({ blockhash: '11111111111111111111111111111112', previousBlockhash: '11111111111111111111111111111113', blockHeight, signatures: receipt ? [receipt.signature] : [] }),
  }
}
async function resolverFor(rows, receipts = [null, null], simulated = () => null) {
  const bundle = JSON.parse(readFileSync(new URL('../config/hooklab-production-bundle-2.json', import.meta.url), 'utf8'))
  const origins = bundle.config.providerTrustDomains.map(t => t.origin)
  const connections = bundle.profile.providers.map((provider, i) => ({ provider, connection: Object.assign(chain({ rows, receipt: receipts[i], simulated }), { rpcEndpoint: origins[i] + 'rpc' }) }))
  const limits = { maxAgeMs: 60000, maxSlotLag: 150, computeUnitPriceMicroLamports: '10000', maxNetworkFeeLamports: '29000' }
  const tokenData = Buffer.from(rows[pda(LOADER, kb(PROGRAMS.token))].dataBase64, 'base64')
  return { resolver: walletFundingResolver({ config: bundle.config, profile: bundle.profile, dossierJson: bundle.dossierJson, connections, limits, clock: () => NOW, bridgePin: pin,
    tokenProgramDataSha256: sha(tokenData) }), connections }
}
const receiptFor = (review, signed, movements, error = null) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(signed, 'base64')), keys = review.accounts.map(a => a.address)
  const pre = keys.map(() => 10_000_000_000), post = keys.map((k, i) => pre[i] + Number(movements[k] ?? 0))
  return { signature: bs58.encode(tx.signatures[0]), slot: 1001, transaction: { message: tx.message, signatures: tx.signatures.map(s => bs58.encode(s)) },
    meta: { err: error, fee: 7000, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] } } }
}

const HOLDING_RENT = 1686560, exactFund = (lamports, creates) => address => address === OWNER ? 1_000_000_000 - 7000 - creates * HOLDING_RENT - lamports : HOLDING_RENT
test('resolver: review, identical revalidation, then a receipt with exactly the reviewed movements settles', async () => {
  const rows = state(), { resolver } = await resolverFor(rows, [null, null], exactFund(1000000, 2))
  const prepared = await resolver.prepare({ owner: OWNER, stage: 'wallet-fund', intent: { action: 'fund', mint: COIN, lamports: '1000000' } })
  assert.equal(prepared.status, 'operator-pins-and-state-verified'); assert.equal(prepared.review.operation, 'hooklab-wallet-fund')
  await assert.rejects(resolver.prepare({ owner: OWNER, stage: 'wallet-withdraw', intent: { action: 'fund', mint: COIN, lamports: '1' } }), /stage and action differ/)
  const again = await resolver.revalidate({ owner: OWNER, stage: 'wallet-fund', review: prepared.review, configurationSha256: prepared.configurationSha256, settlementContext: prepared.settlementContext })
  assert.equal(again.review.messageSha256, prepared.review.messageSha256)
  const tx = VersionedTransaction.deserialize(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(prepared.review.messageBase64, 'base64')])); tx.sign([owner])
  const signed = Buffer.from(tx.serialize()).toString('base64'), q = prepared.request.quote, rent = 1686560
  const exact = { [OWNER]: -(7000 + 2 * rent + 1000000), [d.bridgeSolVault]: 1000000, [q.createdHoldings[0]]: rent, [q.createdHoldings[1]]: rent }
  const args = { review: prepared.review, configurationSha256: prepared.configurationSha256, settlementContext: prepared.settlementContext, signedTransactionBase64: signed, signature: bs58.encode(tx.signatures[0]) }
  const settle = async (a, b) => (await resolverFor(rows, [a, b])).resolver.reconcile(args)
  const good = receiptFor(prepared.review, signed, exact)
  assert.equal((await settle(good, good)).status, 'finalized-success')
  assert.equal((await settle(good, null)).status, 'unresolved', 'one provider has not finalized it')
  const off = receiptFor(prepared.review, signed, { ...exact, [d.bridgeSolVault]: 999999 })
  assert.equal((await settle(off, off)).status, 'unresolved', 'movements differ from the review: never reported as success')
  assert.equal((await settle(good, off)).status, 'conflict')
  const failed = receiptFor(prepared.review, signed, { [OWNER]: -7000 }, { InstructionError: [4, 'Custom'] })
  assert.equal((await settle(failed, failed)).status, 'finalized-failure')
})

test('resolver: a simulation that moves more of the customer’s SOL than reviewed is refused before signing', async () => {
  const rows = state(), { resolver } = await resolverFor(rows, [null, null], address => address === OWNER ? 1_000_000_000 - 7000 - 2 * HOLDING_RENT - 1000000 - 1 : HOLDING_RENT)
  await assert.rejects(resolver.prepare({ owner: OWNER, stage: 'wallet-fund', intent: { action: 'fund', mint: COIN, lamports: '1000000' } }), /movements differ/)
})

test('resolver: providers at different slots still agree while the bridge totals move; the bridge must still be pinned at confirmed', async () => {
  // Provider two sees a later wrap by someone else: more vault lamports, a higher wrapped total and supply.
  const rows = state(), later = { ...rows,
    [d.bridgeSolVault]: { ...rows[d.bridgeSolVault], lamports: '17100900880' },
    [d.bridgeNativeWrapper]: acct(d.bridgeNativeWrapper, PROGRAMS.bridge, wrapper({ total_wrapped: new BN(17100000000) })),
    [QUOTE_MINT]: acct(QUOTE_MINT, PROGRAMS.token, mintWith({ supply: new BN(17100000000) })) }
  const { resolver, connections } = await resolverFor(rows, [null, null], exactFund(1000000, 2))
  const second = chain({ rows: later, simulated: exactFund(1000000, 2) })
  Object.assign(connections[1].connection, { getMultipleAccountsInfoAndContext: second.getMultipleAccountsInfoAndContext })
  const prepared = await resolver.prepare({ owner: OWNER, stage: 'wallet-fund', intent: { action: 'fund', mint: COIN, lamports: '1000000' } })
  assert.equal(prepared.review.operation, 'hooklab-wallet-fund')
  // A real difference (another account) still refuses.
  const moved = chain({ rows: { ...rows, [OWNER]: { ...rows[OWNER], lamports: '999999999' } }, simulated: exactFund(1000000, 2) })
  Object.assign(connections[1].connection, { getMultipleAccountsInfoAndContext: moved.getMultipleAccountsInfoAndContext })
  await assert.rejects(resolver.prepare({ owner: OWNER, stage: 'wallet-fund', intent: { action: 'fund', mint: COIN, lamports: '1000000' } }), /disagree/)
  // A bridge upgraded at confirmed (not yet finalized) is refused.
  const upgraded = { ...rows, [pin.programData]: acct(pin.programData, LOADER, programDataBytes(pin.upgradeAuthority, Buffer.alloc(64, 0x44))) }
  const sneaky = chain({ rows, simulated: exactFund(1000000, 2) }), confirmedRows = chain({ rows: upgraded })
  Object.assign(connections[1].connection, { getMultipleAccountsInfoAndContext: async (keys, options) => (options?.commitment === 'confirmed' ? confirmedRows : sneaky).getMultipleAccountsInfoAndContext(keys) })
  await assert.rejects(resolver.prepare({ owner: OWNER, stage: 'wallet-fund', intent: { action: 'fund', mint: COIN, lamports: '1000000' } }), /Bridge code or upgrade authority/)
})
