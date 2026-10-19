// Customer wallet funding: add SOL to Hook Lab (create holdings + wrap) and withdraw it (unwrap). Synthetic accounts are
// encoded with the pinned production codecs; the bridge program uses a synthetic ELF through the test-only bridge pin.
// (Real-chain proof: the same compiler's transactions simulate cleanly on mainnet; see docs in the PR.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import BN from 'bn.js'
import { compileWalletFundingReview, walletFundingInventory } from '../src/hooklab-wallet-funding.mjs'
import { PROGRAMS, QUOTE_MINT, MAINNET_GENESIS, LOADER, SYSTEM, holdingAddress, pda, kb } from '../src/hooklab-owner-driver/pins.mjs'
import { jsonbRoundTrip } from './fixtures/jsonb-round-trip.mjs'
import { COIN, HOLDING_RENT, LIMITS, NOW, OWNER, acct, bundle, chain, config, d, exactFund, holdingBytes, mintWith, nextBundle, owner, pin, programDataBytes,
  receiptFor, resolverFor, sha, state, wrapper } from './fixtures/hooklab-wallet-funding-chain.mjs'

const profile = { genesisHash: MAINNET_GENESIS, programs: PROGRAMS, quoteMint: QUOTE_MINT, profileSha256: 'a'.repeat(64), providers: ['helius', 'solana-labs'] }
const RENT = { holdingLamports: '1686560', walletLamports: '890880', vaultLamports: '890880' }
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

// A landed Add SOL as production keeps it: review and context read back from jsonb, reconciled after a restart.
async function landedFund(bootLimits) {
  const rows = state(), { resolver } = await resolverFor(rows, [null, null], exactFund(1000000, 2), bootLimits)
  const prepared = await resolver.prepare({ owner: OWNER, stage: 'wallet-fund', intent: { action: 'fund', mint: COIN, lamports: '1000000' } })
  const tx = VersionedTransaction.deserialize(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(prepared.review.messageBase64, 'base64')])); tx.sign([owner])
  const signed = Buffer.from(tx.serialize()).toString('base64'), q = prepared.request.quote, rent = 1686560
  const receipt = receiptFor(prepared.review, signed, { [OWNER]: -(7000 + 2 * rent + 1000000), [d.bridgeSolVault]: 1000000, [q.createdHoldings[0]]: rent, [q.createdHoldings[1]]: rent })
  const stored = jsonbRoundTrip({ review: prepared.review, configurationSha256: prepared.configurationSha256, settlementContext: prepared.settlementContext })
  const reconcile = async (args, limits = bootLimits, options) => (await resolverFor(rows, [receipt, receipt], () => null, limits, options)).resolver.reconcile({ ...stored, ...args, signedTransactionBase64: signed, signature: bs58.encode(tx.signatures[0]) })
  return { rows, prepared, stored, reconcile }
}

test('resolver (F2): a fund reviewed under bundle 2 settles after the next bundle deploys, only while bundle 2 is a reviewed profile', async () => {
  const { stored, reconcile } = await landedFund({ nowMs: NOW - 3600000 }), next = nextBundle(bundle)
  assert.notEqual(next.config.profileSha256, bundle.config.profileSha256)
  assert.equal((await reconcile({}, { nowMs: NOW }, { from: next })).status, 'finalized-success', 'the code-pinned list holds bundle 2')
  assert.equal((await reconcile({}, { nowMs: NOW }, { from: next, reviewedProfiles: [next.config.profileSha256] })).status, 'unresolved', 'a profile not in the list never settles')
  const renamed = jsonbRoundTrip(stored.settlementContext); renamed.compilationInput.profile.quoteMint = PROGRAMS.token
  assert.equal((await reconcile({ settlementContext: renamed }, { nowMs: NOW }, { from: next })).status, 'unresolved', 'a reviewed hash on other programs or mints')
})
const tokenProgramData = pda(LOADER, kb(PROGRAMS.token))

test('resolver: a landed fund settles from its jsonb-stored review and context, also after a restart', async () => {
  const { prepared, stored, reconcile } = await landedFund({ nowMs: NOW - 3600000 })
  assert.notEqual(JSON.stringify(stored.settlementContext), JSON.stringify(prepared.settlementContext), 'jsonb reorders keys')
  assert.equal((await reconcile({})).status, 'finalized-success', 'read back from jsonb')
  assert.equal((await reconcile({}, { nowMs: NOW })).status, 'finalized-success', 'after a restart with a new boot clock')
  assert.notEqual((await resolverFor(state(), [null, null], () => null, { nowMs: NOW, maxNetworkFeeLamports: '30000' })).resolver.configurationSha256, stored.configurationSha256, 'other limits still count')
  // policySha256 still binds the observed state: any changed observed byte never settles.
  const changed = jsonbRoundTrip(stored.settlementContext)
  for (const o of changed.compilationInput.observations) o.accounts.find(x => x.address === tokenProgramData).account.dataBase64 = Buffer.alloc(8, 1).toString('base64')
  assert.equal((await reconcile({ settlementContext: changed })).status, 'unresolved')
})

test('resolver: rows stored under the old boot-time configuration hash settle only when bound to the same profile', async () => {
  const boot = { nowMs: NOW - 3600000 }, { stored, reconcile } = await landedFund(boot)
  const legacy = sha(JSON.stringify({ funding: 1, config: bundle.config, profile: bundle.profile, dossierJson: bundle.dossierJson, limits: { ...LIMITS, ...boot } }))
  const context = { ...stored.settlementContext, configurationSha256: legacy }
  assert.equal((await reconcile({ configurationSha256: legacy, settlementContext: context }, { nowMs: NOW })).status, 'finalized-success')
  assert.equal((await reconcile({ configurationSha256: legacy, settlementContext: stored.settlementContext }, { nowMs: NOW })).status, 'unresolved', 'context bound to another hash')
  const otherProfile = jsonbRoundTrip(context); otherProfile.compilationInput.profile.providers = [...otherProfile.compilationInput.profile.providers].reverse()
  assert.equal((await reconcile({ configurationSha256: legacy, settlementContext: otherProfile }, { nowMs: NOW })).status, 'unresolved', 'another profile')
  // Before signing the hash must match exactly. It survives a restart now; a legacy row is reviewed again.
  const { resolver } = await resolverFor(state(), [null, null], exactFund(1000000, 2), { nowMs: NOW }), fresh = { owner: OWNER, stage: 'wallet-fund', review: stored.review }
  assert.equal((await resolver.revalidate({ ...fresh, configurationSha256: stored.configurationSha256, settlementContext: stored.settlementContext })).review.messageSha256, stored.review.messageSha256)
  await assert.rejects(resolver.revalidate({ ...fresh, configurationSha256: legacy, settlementContext: context }))
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
