// Production bundle 3 pins the native swap and launch ELFs by their trimmed bytes (what a deployed ProgramData holds,
// trailing zeros removed); a profile may also pin the raw build output. Either form opens native trading, and a native
// buy compiles, lands and settles on the reviewed native ELFs; the compiler compares the trimmed ProgramData bytes for
// both, so a ProgramData sized to the trimmed bytes reads the same, and any other bytes are refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeTradeResolver } from '../src/hooklab-native-trade-resolver.mjs'
import { compileNativeSwapReview, pinsNativeBuilds } from '../src/hooklab-native-swap.mjs'
import { NATIVE_ELF } from '../src/hooklab-native-pins.mjs'
import { nativeWorld, NATIVE_SKIP } from './fixtures/hooklab-native-world.mjs'
import { nativePinned } from './fixtures/hooklab-native-bundle.mjs'
import { jsonbRoundTrip } from './fixtures/jsonb-round-trip.mjs'
import { loader, pda, pk } from './fixtures/hooklab-canary.mjs'

const LIMITS = { maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: 0, reviewExpiresAtMs: 0, maxNetworkFeeLamports: '10000', maxTotalDebitLamports: '10000', computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0' }
const BOOT = 1800000000000, HEADER = 45
const store = p => jsonbRoundTrip({ review: p.review, configurationSha256: p.configurationSha256, settlementContext: p.settlementContext })

test('native trading on a profile pinning the trimmed native ELFs (as production bundle 3) or the raw build output', { skip: NATIVE_SKIP, timeout: 600000 }, async t => {
  const w = await nativeWorld({ capBps: 5000 }); t.after(w.close)
  const { roles } = w, programs = JSON.parse(w.state.profile.json).programs
  const buy = async trader => ({ side: 'buy', creatorFeeBps: 100, capBps: 5000, mint: roles.mint, selectedConfig: roles.config, amountIn: '1000003',
    minAmountOut: await w.minimumOut('buy', '1000003', trader), maxInput: '1000003', maxPriceImpactBps: 1000, graduate: false })
  let input = null

  for (const [form, trader] of [['trimmed', roles.creator], ['raw', roles.buyer]]) {
    await t.test(`${form} pins: native trading opens, and a native buy compiles, lands and settles`, async () => {
      const bindings = nativePinned(w.bindings, { elf: form })
      assert.equal(pinsNativeBuilds(bindings.profile), true, 'the trade runtime opens native trading on this profile')
      const resolver = nativeTradeResolver({ ...bindings, connections: w.connections(), limits: { ...LIMITS, nowMs: BOOT }, clock: () => 1000 })
      const prepared = await resolver.prepare({ owner: trader, stage: 'native-buy', intent: await buy(trader) })
      assert.equal(prepared.profileSha256, bindings.profile.expectedSha256)
      const sent = await w.send(prepared.review.messageBase64)
      assert.equal(sent.error, null, JSON.stringify(sent.logs?.slice(-6)))
      const settled = await resolver.reconcile({ ...store(prepared), signedTransactionBase64: sent.wireBase64, signature: sent.signature })
      assert.equal(settled.status, 'finalized-success')
      input = prepared.settlementContext.compilationInput
    })
  }

  await t.test('either form reads a ProgramData holding the trimmed bytes, sized to them or longer, and refuses any other bytes', () => {
    assert.ok(input, 'a reviewed buy to recompile')
    // The observed ProgramData of one native program, changed; the same change on both providers.
    const changed = (role, change) => {
      const address = pda(loader, pk(programs[role]).toBuffer())
      return { ...input, observations: input.observations.map(o => ({ ...o, accounts: o.accounts.map(x => {
        if (x.address !== address) return x
        const data = change(Buffer.from(x.account.dataBase64, 'base64'), NATIVE_ELF[role].trimmedLength)
        return { ...x, account: { ...x.account, dataBase64: Buffer.from(data).toString('base64') } }
      }) })) }
    }
    const sizedToTrimmed = (data, trimmed) => data.subarray(0, HEADER + trimmed)
    const elfByte = (data, trimmed) => { const b = Buffer.from(data); b[HEADER + trimmed - 1] ^= 1; return b }
    const afterTrimmed = (data, trimmed) => { const b = Buffer.from(data); b[HEADER + trimmed] = 1; return b }
    for (const form of ['trimmed', 'raw']) {
      const profile = nativePinned(w.bindings, { elf: form }).profile, compile = x => compileNativeSwapReview({ ...x, profile })
      assert.ok(compile(input), `${form}: today's ProgramData (the raw build's length)`)
      for (const role of ['swap', 'launch']) {
        assert.ok(compile(changed(role, sizedToTrimmed)), `${form}: ${role} ProgramData sized to the trimmed bytes`)
        assert.throws(() => compile(changed(role, elfByte)), /Program ELF differs/, `${form}: ${role} with one ELF byte changed`)
        assert.throws(() => compile(changed(role, afterTrimmed)), /Program ELF differs/, `${form}: ${role} with a byte after the trimmed ELF`)
      }
    }
  })
})
