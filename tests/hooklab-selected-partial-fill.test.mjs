import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { selectedNativeMeasuredQuote, compileNativeSwapReview } from '../src/hooklab-native-swap.mjs'
import { selectedNativeTradeFixture } from './fixtures/selected-native-trade.mjs'
import { encodeHookAccountList } from '@repo-ing/hooklab-production-candidate'
import { PublicKey, Keypair } from '@solana/web3.js'
import { createHash } from 'node:crypto'
import { collectSelectedNativeTradeReview } from '../src/hooklab-native-trade-resolver.mjs'
import { measuredTradeMinimum } from '../app/lib/hooklab-trade-math.mjs'

test('a filled quote scales the wire minimum so the consumed fraction retains the chosen protection', () => {
  // The contract floors raw minimum * consumed / requested. Passing the displayed
  // minimum directly would lower protection from 97 tokens to only 12.
  const quote = { delivered: '100', consumedInput: '13', unspentInput: '88' }
  const minimum = measuredTradeMinimum(quote, 300)
  assert.equal(minimum, 754n)
  assert.equal(minimum * 13n / 101n, 97n)
})

function quoteCutFixture() {
  const f = selectedNativeTradeFixture('buy', { feeModel: 1 })
  const pk = value => new PublicKey(value), L = f.p.programs.launch, T = f.p.programs.token, H = f.request.selectedHook.program
  const derive = (program, seed, value) => PublicKey.findProgramAddressSync([Buffer.from(seed), pk(value).toBuffer()], pk(program))
  const [state, stateBump] = derive(H, 'state', f.request.mint), [signer, signerBump] = derive(L, 'quote-cut', H)
  for (const [name, address] of [['LaunchConfig', f.request.selectedConfig], ['Launch', f.a.launch]]) {
    const account = f.accounts.get(address), bytes = Buffer.from(account.dataBase64, 'base64'), value = f.coders.launch.accounts.decode(name, bytes)
    const reserved = Buffer.from(value.reserved)
    reserved.writeUInt16LE(321, name === 'Launch' ? 0 : 1); reserved.writeUInt16LE(87, name === 'Launch' ? 2 : 3)
    if (name === 'Launch') { reserved[12] = stateBump; reserved[13] = signerBump }
    value.reserved = [...reserved]; f.coders.launch.types.encode(name, value).copy(bytes, 8); account.dataBase64 = bytes.toString('base64')
  }
  const literal = bytes => ({ kind: 'literal', bytes: Buffer.from(bytes) }), ref = index => ({ kind: 'account', index })
  const pda = (program, seeds, writable) => ({ writable, source: { kind: 'pda', program: pk(program), seeds } })
  const fixed = (address, writable) => ({ writable, source: { kind: 'key', key: pk(address) } })
  f.accounts.get(f.a.poolRegistry).dataBase64 = encodeHookAccountList({ version: 1, accounts: [
    pda(L, [literal('launch'), ref(2)], true), pda(T, [literal('holding'), ref(3), ref(5)], true),
    fixed(f.a.holderVault, true), fixed(f.a.kitConfig, false), fixed(H, false),
    pda(T, [literal('holding'), ref(2), ref(4)], false), pda(H, [literal('state'), ref(2)], true), pda(L, [literal('quote-cut'), ref(9)], false),
  ] }).toString('base64')
  // Inventory is server-collected; absence is itself observed for derived signer/state addresses.
  for (const o of f.input.observations) for (const address of [state.toBase58(), signer.toBase58()])
    assert.ok(o.accounts.some(x => x.address === address && x.account === null))
  return { f, H, state, signer }
}

test('configured quote-cut trades validate caps/registry and append the exact four callback accounts', () => {
  const { f, H, state, signer } = quoteCutFixture()
  const plan = compileNativeSwapReview({ ...f.input, selectedQuoteCutBps: 0 })
  assert.equal(plan.economics.quoteCutBps, 0) // creator's self trade is exempt
  assert.deepEqual(plan.instructions.at(-1).accounts.slice(-4).map(x => x.address), [H, f.a.traderBase, state.toBase58(), signer.toBase58()])
  assert.ok(plan.review.accounts.find(x => x.address === state.toBase58()).writable)
  assert.throws(() => compileNativeSwapReview({ ...f.input, selectedQuoteCutBps: 123 }), /cap|cut/i)
  assert.throws(() => compileNativeSwapReview({ ...f.input, selectedQuoteCutBps: 322 }), /cap|cut/i)
})

test('the collector measures a capped custom quote answer and requires its exact payout, identity and provider agreement', async () => {
  const { f } = quoteCutFixture(), pk = value => new PublicKey(value), L = f.p.programs.launch
  for (const [role, name, address] of [['launch', 'Launch', f.a.launch], ['swap', 'Pool', f.a.pool]]) {
    const a = f.accounts.get(address), bytes = Buffer.from(a.dataBase64, 'base64'), state = f.coders[role].accounts.decode(name, bytes)
    state.virtual_quote = new BN(5000)
    if (name === 'Launch') { state.creator = Keypair.fromSeed(Buffer.alloc(32, 94)).publicKey; state.graduation_quote = new BN(10000) }
    f.coders[role].types.encode(name, state).copy(bytes, 8); a.dataBase64 = bytes.toString('base64')
  }
  const pool = f.coders.swap.accounts.decode('Pool', Buffer.from(f.accounts.get(f.a.pool).dataBase64, 'base64'))
  // 101 in: creator=2 + custom=3 gross; platform=floor(5/4)=1, creator residual=4, curve=96.
  const delivered = 96n * BigInt(pool.base_reserve.add(pool.virtual_base).toString()) / 5096n
  Object.assign(f.input.request, { amountIn: '101', maxInput: '101', minAmountOut: String(delivered * 97n / 100n) })
  const after = new Map([...f.accounts].map(([k, v]) => [k, structuredClone(v)]))
  for (const [address, delta] of [[f.a.baseVault, -delivered], [f.a.traderBase, delivered]]) {
    const a = after.get(address), bytes = Buffer.from(a.dataBase64, 'base64'); bytes.writeBigUInt64LE(bytes.readBigUInt64LE(74) + delta, 74); a.dataBase64 = bytes.toString('base64')
  }
  for (const [address, delta] of [[f.request.trader, -5101n], [f.a.launch, 4n], [f.a.pool, 97n]])
    after.get(address).lamports = String(BigInt(after.get(address).lamports) + delta)
  const event = Buffer.alloc(85); createHash('sha256').update('event:QuoteCutTaken').digest().copy(event, 0, 0, 8)
  pk(f.a.launch).toBuffer().copy(event, 8); pk(f.request.trader).toBuffer().copy(event, 40); event[72] = 1
  event.writeUInt16LE(900, 73); event.writeUInt16LE(321, 75); event.writeBigUInt64LE(3n, 77)
  let corrupt = () => {}
  const connections = f.input.profile.providers.map((provider, index) => ({ provider, connection: {
    getGenesisHash: async () => f.p.genesisHash, isBlockhashValid: async () => ({ context: { slot: 100 }, value: true }),
    getBlockHeight: async () => 100, getFeeForMessage: async () => ({ context: { slot: 100 }, value: 5000 }),
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: 100 }, value: keys.map(k => { const a = f.accounts.get(k.toBase58()); return a ? { ...a, owner: pk(a.owner), lamports: Number(a.lamports), data: Buffer.from(a.dataBase64, 'base64') } : null }) }),
    simulateTransaction: async (_, options) => {
      const observed = Buffer.from(event); corrupt(observed, index)
      return { context: { slot: 100 }, value: { err: null, unitsConsumed: 50000,
        logs: [`Program ${L} invoke [1]`, `Program data: ${observed.toString('base64')}`, `Program ${L} success`],
        accounts: options.accounts.addresses.map(address => { const a = after.get(address); return a ? { owner: a.owner, executable: a.executable, lamports: Number(a.lamports), data: [a.dataBase64, 'base64'] } : null }) } }
    },
  } }))
  const collect = () => collectSelectedNativeTradeReview({ compilationInput: f.input, configurationSha256: 'a'.repeat(64), connections, clock: () => 1200 })
  const result = await collect()
  assert.equal(result.plan.quote.hookQuoteFee, '3'); assert.equal(result.plan.quote.netCreatorFee, '4'); assert.equal(result.plan.quote.protocolFee, '1')
  assert.equal(result.compilationInput.selectedQuoteCutBps, 321)
  for (const change of [b => { b[40] ^= 1 }, b => b.writeUInt16LE(322, 75), b => b.writeBigUInt64LE(4n, 77), (b, i) => { if (i) b[73] ^= 1 }]) {
    corrupt = change; await assert.rejects(collect())
  }
})

test('measured final fill uses consumed input and applies minimum to that fraction', () => {
  const request = { side: 'buy', amountIn: '101', maxInput: '101', minAmountOut: '85',
    creatorFeeBps: 1000, feeModel: 1, protocolShareBps: 2500, graduate: false }
  const pool = { baseReserve: 10n, quoteReserve: 100n, virtualBase: 100n, virtualQuote: 0n, protocolFeesQuote: 7n }
  const addresses = { baseVault: 'vault', traderBase: 'trader' }
  const deltas = { vault: '-10', trader: '10' }
  const economics = { allowPartialFill: true }
  // 12 quote consumed: gross creator fee 2, platform 0, creator 2, curve input 10.
  // The requested minimum of 85 prorates to floor(85 * 12 / 101) = 10.
  const q = selectedNativeMeasuredQuote(request, pool, deltas, addresses, economics)
  assert.equal(q.traderDebit, 12n)
  assert.equal(q.unspentInput, 89n)
  assert.equal(q.minAmountOut, 10n)
  assert.equal(q.delivered, 10n)
  assert.equal(q.fees.creatorQuote, 2n)
  assert.equal(q.fees.protocolQuote, 0n)
  assert.deepEqual(q.after, { baseReserve: 0n, quoteReserve: 110n, protocolFeesQuote: 7n })
  assert.throws(() => selectedNativeMeasuredQuote({ ...request, minAmountOut: '93' }, pool, deltas, addresses, economics), /MIN_OUTPUT/)
  assert.throws(() => selectedNativeMeasuredQuote(request, pool, { ...deltas, vault: '-11' }, addresses, economics), /vault debit/)
})

test('selected share buy graduates on actual readiness rather than the legacy inclusive final-fill amount', () => {
  const f = selectedNativeTradeFixture('buy', { feeModel: 1 })
  const account = f.accounts.get(f.a.pool), bytes = Buffer.from(account.dataBase64, 'base64')
  const pool = f.coders.swap.accounts.decode('Pool', bytes)
  pool.quote_reserve = new BN(990)
  f.coders.swap.types.encode('Pool', pool).copy(bytes, 8)
  account.dataBase64 = bytes.toString('base64')
  Object.assign(f.input.request, { amountIn: '20', maxInput: '20', graduate: true })
  const plan = compileNativeSwapReview(f.input)
  assert.equal(plan.graduates, true)
  assert.equal(plan.quote.after.quoteReserve, '1009')
  assert.equal(plan.quote.netCreatorFee, '1')
  assert.equal(plan.quote.protocolFee, '0')
  assert.equal(plan.economics.allowPartialFill, true)
  assert.equal(plan.instructions.at(-1).program, f.p.programs.launch)
  assert.throws(() => compileNativeSwapReview({ ...f.input, request: { ...f.input.request, graduate: false } }), /curve changed/)
})
