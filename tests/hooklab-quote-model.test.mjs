import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { modelHookLabQuote, revalidateHookLabQuote, QUOTE_PIN } from '../src/hooklab-quote-model.mjs'

const U64 = (1n << 64n) - 1n
const current = { nowMs: 1_000_000, slot: 500 }
function fixture(side = 'buy') {
  return {
    snapshot: {
      manifestSha256: QUOTE_PIN.manifestSha256, genesisHash: QUOTE_PIN.genesisHash,
      quoteMint: QUOTE_PIN.quoteMint, accountsHash: 'a'.repeat(64), poolId: 'fixture-pool', mint: 'fixture-mint',
      observedAtMs: current.nowMs, slot: current.slot, chainTime: 200_000, quoteHook: 'none', paused: false,
      pool: { feeModel: 'launch-share', baseReserve: 1_000_000n, quoteReserve: 2_000_000n,
        virtualBase: 300_000n, virtualQuote: 400_000n, protocolShareBps: 2500 },
      launch: { creator: 'creator', creatorBought: false, createdAt: 190_000, sniperWindowSecs: 30,
        sniperStartBps: 8000, lpFeeBps: 30, creatorFeeBps: 100,
        holderBuyBps: 0, holderSellBps: 0, burnBuyBps: 0, burnSellBps: 0 },
      wallet: { owner: 'alice', recipient: 'alice', ordinaryWallet: true, recipientAllowed: true,
        recipientOnCurve: true, baseBalance: 500_000n, recipientBaseBalance: 500_000n,
        quoteBalance: 0n, nativeLamports: 10_000_000n },
      hook: { kind: 'none' },
    },
    request: { side, amountIn: 100_001n, maxInput: U64, maxNativeDebitLamports: U64, slippageBps: 100, maxPriceImpactBps: 10_000 },
    budget: { rentLamports: 2_000n, networkFeeLamports: 5_000n, priorityFeeLamports: 301n, reserveLamports: 1_000n },
  }
}
function kit() {
  return { kind: 'kit', eligible: 600_000n, minEligible: 100_000n, maxWalletAmount: 1_000_000n,
    earlyLocked: 0n, rewardsOn: true, graduated: false, maxWalletOn: false, creatorLockOn: false,
    earlyLockOn: false, creatorUnlockAt: 0, earlyWindowEnd: 0, earlyUnlockAt: 0 }
}
const quote = (f) => modelHookLabQuote(f, current)

test('model pin matches vendored manifest, provenance and all 11 IDL bytes', async () => {
  const root = new URL('../vendor/hooklab-readonly/', import.meta.url)
  const bytes = await readFile(new URL('integration/devnet.json', root))
  const manifest = JSON.parse(bytes)
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root)))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), QUOTE_PIN.manifestSha256)
  assert.equal(provenance.revision, QUOTE_PIN.delivery)
  assert.equal(manifest.sourceCommit, QUOTE_PIN.abi)
  assert.equal(manifest.genesisHash, QUOTE_PIN.genesisHash)
  assert.equal(manifest.quoteMint, QUOTE_PIN.quoteMint)
  const idls = manifest.programs.filter(p => p.idlPath)
  assert.equal(idls.length, 11)
  for (const p of idls) {
    const bytes = await readFile(new URL(`idl/${p.role}.json`, root))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), p.idlSha256)
  }
})

test('exact outputs agree with pinned Rust-generated vectors, including small-amount fee dropping', async () => {
  const { swaps } = JSON.parse(await readFile(new URL('./fixtures/hooklab-quote-vectors.json', import.meta.url)))
  for (const v of swaps) {
    const f = fixture(v.side), s = f.snapshot, p = v.params, e = v.expected
    s.pool = { ...s.pool, ...Object.fromEntries(Object.entries(v.reserves).map(([k, n]) => [k, BigInt(n)])), protocolShareBps: v.protocolShareBps }
    Object.assign(s.launch, { lpFeeBps: v.lpFeeBps, creatorFeeBps: p.creatorFeeBps,
      holderBuyBps: p.holderFeeBuyBps, holderSellBps: p.holderFeeSellBps, burnBuyBps: p.burnBuyBps, burnSellBps: p.burnSellBps })
    f.request.amountIn = BigInt(v.amountIn)
    f.request.slippageBps = 0
    s.wallet.baseBalance = s.wallet.recipientBaseBalance = f.request.amountIn
    s.wallet.quoteBalance = f.request.amountIn
    s.hook = p.holderFeeBuyBps || p.holderFeeSellBps
      ? { ...kit(), eligible: BigInt(p.eligible), minEligible: BigInt(p.minEligible) }
      : { kind: 'none' }
    if (e.failure) {
      // The vector format calls both a zero curve result and fees consuming it "no_output".
      const code = { fees_exceed_input: 'FEES_EXCEED_INPUT', insufficient_liquidity: 'INSUFFICIENT_LIQUIDITY',
        no_output: BigInt(e.lpFee) > 0n ? 'FEES_EXCEED_OUTPUT' : 'INSUFFICIENT_LIQUIDITY', fee_exceeds_output: 'FEES_EXCEED_OUTPUT' }[e.failure]
      assert.throws(() => quote(f), { message: code }, v.name)
      continue
    }
    const r = quote(f)
    for (const [actual, expected] of [[r.netOutput, e.delivered], [r.received, e.received], [r.netIn, e.netIn],
      [r.fees.creatorQuote, e.creatorFee], [r.fees.holderQuote, e.holderFee], [r.fees.burnBase, e.burn],
      [r.fees.lpAndSniperQuote, e.lpFee], [r.fees.protocolInputShareQuote + r.fees.protocolOutputShareQuote, e.protocolFee]]) {
      assert.equal(actual, BigInt(expected), `${v.name} ${v.side} ${v.amountIn}`)
    }
  }
})

test('fresh empty wallet pays wrap, rent and network, keeps reserve; no fees counted twice', () => {
  const f = fixture()
  f.snapshot.wallet.baseBalance = f.snapshot.wallet.recipientBaseBalance = 0n
  const r = quote(f)
  assert.equal(r.debit.nativeDebitLamports, 107_302n)
  assert.equal(r.debit.wrapLamports, 100_001n)
  assert.equal(r.executable, false); assert.equal(r.liveReady, false); assert.equal(r.capEnforced, false)
  f.request.maxNativeDebitLamports = 107_302n
  f.snapshot.wallet.nativeLamports = 108_302n
  assert.equal(quote(f).debit.nativeDebitLamports, 107_302n)
  f.snapshot.wallet.nativeLamports--
  assert.throws(() => quote(f), /INSUFFICIENT_NATIVE_RESERVE/)
  f.snapshot.wallet.nativeLamports++
  f.request.maxNativeDebitLamports--
  assert.throws(() => quote(f), /NATIVE_CAP_EXCEEDED/)
  f.request.maxNativeDebitLamports = U64
  f.snapshot.wallet.quoteBalance = 40_000n
  assert.equal(quote(f).debit.nativeDebitLamports, 67_302n)
  f.snapshot.wallet.quoteBalance = 200_000n
  assert.equal(quote(f).debit.nativeDebitLamports, 7_301n)
})

test('selling returns quote tokens, cannot finance native fee reserve from proceeds', () => {
  const f = fixture('sell')
  const r = quote(f)
  assert.equal(r.outputAsset, QUOTE_PIN.quoteMint)
  assert.equal(r.debit.wrapLamports, 0n)
  assert.equal(r.debit.nativeDebitLamports, 7_301n)
  f.snapshot.wallet.nativeLamports = 0n
  assert.throws(() => quote(f), /INSUFFICIENT_NATIVE_RESERVE/)
})

test('sniper interpolation and creator exemption depend on actor, recipient and consumed flag', () => {
  const f = fixture(), s = f.snapshot
  s.launch.createdAt = s.chainTime - 1
  assert.equal(quote(f).fees.effectiveLpBps, 7735)
  s.wallet.owner = s.wallet.recipient = 'creator'
  assert.equal(quote(f).fees.effectiveLpBps, 30)
  s.wallet.recipient = 'bob'
  assert.equal(quote(f).fees.effectiveLpBps, 7735)
  s.wallet.recipient = 'creator'; s.launch.creatorBought = true
  assert.equal(quote(f).fees.effectiveLpBps, 7735)
  s.launch.createdAt = s.chainTime - 30
  assert.equal(quote(f).fees.effectiveLpBps, 30)
})

test('Kit sell eligibility is measured after burn plus transfer; exact threshold is eligible', () => {
  const f = fixture('sell'), s = f.snapshot
  s.hook = kit(); s.launch.holderSellBps = 200; s.launch.burnSellBps = 100
  s.hook.eligible = 200_000n
  assert.equal(quote(f).fees.holderQuote, 0n) // 99,999 remain, below 100,000.
  s.hook.eligible++
  assert.ok(quote(f).fees.holderQuote > 0n)
  f.request.side = 'buy'; s.launch.holderBuyBps = 100
  s.hook.eligible = 99_999n
  assert.equal(quote(f).fees.holderQuote, 0n) // This buy cannot qualify its own fee.
})

test('Kit wallet cap, destination restriction, creator and early locks include exact boundaries', () => {
  const f = fixture(), s = f.snapshot
  s.hook = kit(); s.hook.maxWalletOn = true
  const delivered = quote(f).netOutput
  s.hook.maxWalletAmount = s.wallet.recipientBaseBalance + delivered
  assert.equal(quote(f).netOutput, delivered)
  s.hook.maxWalletAmount--
  assert.throws(() => quote(f), /MAX_WALLET_EXCEEDED/)
  s.hook.graduated = true
  assert.equal(quote(f).netOutput, delivered)
  s.wallet.recipientOnCurve = false
  assert.throws(() => quote(f), /DESTINATION_NOT_ON_CURVE/)
  s.wallet.recipientOnCurve = true
  s.hook.earlyLockOn = true; s.hook.earlyWindowEnd = s.chainTime + 10; s.hook.earlyUnlockAt = s.chainTime + 100
  assert.equal(quote(f).lockedUntil, 200_100)
  f.request.side = 'sell'; s.hook.earlyLocked = s.wallet.baseBalance - f.request.amountIn
  quote(f)
  s.hook.earlyLocked++
  assert.throws(() => quote(f), /EARLY_LOCKED/)
  s.hook.earlyUnlockAt = s.chainTime
  quote(f)
  s.wallet.owner = s.wallet.recipient = 'creator'; s.hook.creatorLockOn = true; s.hook.creatorUnlockAt = s.chainTime + 1
  assert.throws(() => quote(f), /CREATOR_LOCKED/)
  s.hook.creatorUnlockAt = s.chainTime
  quote(f)
})

test('Half-Life charges post-burn sell input, with ceil quote valuation and floor token fee', () => {
  const f = fixture('sell'), s = f.snapshot
  s.pool = { ...s.pool, baseReserve: 1_000_000n, quoteReserve: 1_000_000n, virtualBase: 0n, virtualQuote: 0n }
  f.request.amountIn = 100_000n
  s.launch.burnSellBps = 100
  s.hook = { kind: 'half-life', poolRecognized: true, furnaceLit: true, sourceSince: s.chainTime - 10_800 }
  const r = quote(f)
  assert.equal(r.fees.burnBase, 1_000n)
  assert.equal(r.fees.halfLifePpm, 150_000)
  assert.equal(r.fees.tokenHookBase, 14_850n)
  assert.equal(r.received, 84_150n)
  assert.equal(r.grossOutput, 77_618n)
  assert.equal(r.fees.protocolInputShareQuote, 3_425n)
  assert.equal(r.netOutput, 73_035n)
  s.hook.furnaceLit = false
  assert.throws(() => quote(f), /FURNACE_NOT_LIT/)
  f.request.side = 'buy'
  assert.equal(quote(f).fees.tokenHookBase, 0n) // Pool is exempt even if furnace is unlit.
})

test('Half-Life unknown/future ages charge maximum; six hours halves, 48 hours removes fee', () => {
  const f = fixture('sell'), s = f.snapshot
  s.hook = { kind: 'half-life', poolRecognized: true, furnaceLit: true, sourceSince: null }
  for (const [since, ppm] of [[null, 200_000], [s.chainTime + 1, 200_000], [s.chainTime - 21_599, 100_005],
    [s.chainTime - 21_600, 100_000], [s.chainTime - 172_799, 782], [s.chainTime - 172_800, 0]]) {
    s.hook.sourceSince = since
    assert.equal(quote(f).fees.halfLifePpm, ppm)
  }
})

test('slippage uses net delivery, refuses zero min-out, and price impact excludes fees', () => {
  const f = fixture()
  const r = quote(f)
  assert.equal(r.minOutput, r.netOutput * 99n / 100n)
  assert.equal(r.priceImpactBps, 395) // ceil(98,452 × 10,000 / 2,498,452).
  assert.ok(r.allInLossBps > r.priceImpactBps)
  f.request.maxPriceImpactBps = r.priceImpactBps
  quote(f)
  f.request.maxPriceImpactBps--
  assert.throws(() => quote(f), /PRICE_IMPACT_LIMIT/)
  f.request.maxPriceImpactBps = 10_000
  f.request.slippageBps = 10_000
  assert.throws(() => quote(f), /INVALID_SLIPPAGE/)
  f.request.slippageBps = 9999
  f.request.amountIn = 10n
  assert.throws(() => quote(f), /ZERO_MIN_OUT/)
})

test('expiry is exclusive, slot age inclusive, and changed state/intent/budget always requotes', () => {
  const f = fixture(), r = quote(f)
  const check = (nowMs, slot) => revalidateHookLabQuote(r, f, { nowMs, slot })
  check(1_014_999, 532)
  assert.throws(() => check(1_015_000, 532), /QUOTE_EXPIRED/)
  assert.throws(() => check(1_000_001, 533), /STALE_SLOT/)
  for (const change of [g => g.snapshot.accountsHash = 'b'.repeat(64), g => g.snapshot.pool.quoteReserve++,
    g => g.snapshot.chainTime++, g => g.snapshot.launch.creatorBought = true, g => g.snapshot.wallet.owner = 'bob',
    g => g.request.slippageBps++, g => g.budget.rentLamports++]) {
    const g = structuredClone(f); change(g)
    assert.throws(() => revalidateHookLabQuote(r, g, current), /STALE_STATE/)
  }
  f.snapshot.observedAtMs += 500; f.snapshot.slot++
  assert.equal(check(1_001_000, 502).expiresAtMs, r.expiresAtMs)
  assert.throws(() => check(1_015_000, 502), /QUOTE_EXPIRED/)
})

test('incomplete, unsupported, unsafe and illiquid inputs refuse instead of inventing a quote', () => {
  const large = fixture()
  large.request.amountIn = large.snapshot.wallet.quoteBalance = 9_007_199_254_740_993n
  Object.assign(large.snapshot.pool, { baseReserve: U64 / 2n, quoteReserve: U64 / 2n, virtualBase: 0n, virtualQuote: 0n })
  Object.assign(large.snapshot.launch, { lpFeeBps: 0, creatorFeeBps: 0 })
  assert.equal(quote(large).netOutput, 8_998_411_743_272_953n)
  large.snapshot.pool.quoteReserve = U64
  assert.throws(() => quote(large), /INVALID_U64/) // Reserve addition overflows even though input fits.
  const cases = [
    [f => delete f.budget.rentLamports, /INVALID_U64/],
    [f => f.request.amountIn = Number.MAX_SAFE_INTEGER, /INVALID_U64/],
    [f => f.request.amountIn = U64 + 1n, /INVALID_U64/],
    [f => f.request.amountIn = 0n, /ZERO_INPUT/],
    [f => f.request.maxInput = 1n, /INPUT_CAP_EXCEEDED/],
    [f => f.snapshot.manifestSha256 = 'bad', /PIN_MISMATCH/],
    [f => f.snapshot.quoteHook = 'tax', /UNSUPPORTED_QUOTE_HOOK/],
    [f => f.snapshot.hook.kind = 'lottery', /UNSUPPORTED_TOKEN_HOOK/],
    [f => f.snapshot.pool.feeModel = 'flat', /UNSUPPORTED_POOL/],
    [f => f.snapshot.pool.baseReserve = 1n, /INSUFFICIENT_LIQUIDITY/],
    [f => f.snapshot.paused = true, /PAUSED/],
    [f => f.snapshot.wallet.recipientAllowed = false, /WALLET_INELIGIBLE/],
    [f => f.snapshot.observedAtMs++, /FUTURE_SNAPSHOT/],
  ]
  for (const [change, error] of cases) { const f = fixture(); change(f); assert.throws(() => quote(f), error) }
})
