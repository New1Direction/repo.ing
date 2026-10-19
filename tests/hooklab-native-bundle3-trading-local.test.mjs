// Bundle 3 end to end on a disposable solana-test-validator running the e357fdf native ELFs at the mainnet program IDs
// (tests/fixtures/hooklab-bundle3-local.mjs): the owner driver opens launches and trading and turns native launches on;
// #326's script and production collector build bundle 3; the trade runtime boots from it exactly as the production
// bootstrap does, with HOOK_NATIVE_TRADING_ENABLED=true; a customer coin is prepared and launched native through the
// website collectors; a native buy and a sale settle through the real resolver, signing lifecycle and settlement with the
// chain's deltas and fee split exact. The same bootstrap with bundle 2 keeps native trading off.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { BUNDLE3_LOCAL_SKIP, ROOT, bundle3Chain, openNativeChain, buildBundle3, scratchDatabase, signIn, bootEnv, bundle3Origins, bootRuntime, launchNativeCoin,
  exactNativeBuy, exactNativeSell, coinsOf } from './fixtures/hooklab-bundle3-local.mjs'

test('bundle 3 end to end on a local validator: bootstrap opens native trading, a native buy and sale settle exactly; bundle 2 keeps it off', { skip: BUNDLE3_LOCAL_SKIP, timeout: 1800000 }, async t => {
  const c = await bundle3Chain(t), buyer = Keypair.generate(), token = Buffer.alloc(32, 61).toString('base64url')
  let built, pool, s, runtime, coin

  await t.test('chain: approved configs, immutable gate, a creator grant, launches and trading open, native launches on', async () => {
    await openNativeChain(c)
    await c.fund([[buyer.publicKey.toBase58(), 2000000000]])
  })
  await t.test('bundle 3: the script builds it on the validator, and the production collector builds the same pins', async () => {
    built = await buildBundle3(c)
    t.diagnostic(`bundle 3 profile sha256 ${built.bundle.config.profileSha256}; local dry-run bundle sha256 ${built.summary.bundleSha256}`)
  })
  await t.test('bootstrap from bundle 3 with HOOK_NATIVE_TRADING_ENABLED=true opens native trading; the local dry-run bundle is refused', async () => {
    pool = await scratchDatabase(t)
    ;({ s, runtime } = await bootRuntime(c, pool, bootEnv(built.file, built.bytes, c.a('admin'), bundle3Origins())))
    assert.equal(runtime.nativeTrading, true)
    assert.equal((await bootRuntime(c, pool, bootEnv(built.file, built.bytes, c.a('admin'), bundle3Origins(), { HOOK_NATIVE_TRADING_ENABLED: 'false' }))).runtime.nativeTrading, false, 'the switch off')
    await assert.rejects(bootRuntime(c, pool, bootEnv(built.local.file, built.local.bytes, c.a('admin'), bundle3Origins())), /bundle reviewer is not the configured launch admin/,
      'production never boots the local-schema dry run')
  })
  await t.test('a customer coin is prepared and launched native through the website collectors on bundle 3', async () => {
    coin = await launchNativeCoin(c, s, built.bundle, { creator: c.roles.creator, mint: c.roles.mint, selectedConfig: c.roles.selectedConfig })
  })
  await t.test('a native buy: one approval, one send, settled; the chain moved exactly the reviewed lamports and fee split', async () => {
    await signIn(pool, token, buyer.publicKey.toBase58())
    const { op, chain, G, P, N, rent } = await exactNativeBuy(c, runtime, built.bundle, { token, wallet: buyer, coin, amount: 10000003n })
    t.diagnostic(`buy ${op.signature}: fee ${chain.fee}, rent ${rent}, G ${G} P ${P} N ${N}, delivered ${op.settlement.quote.delivered}`)
  })
  await t.test('a native sale: SOL straight to the wallet, settled; exact deltas and fee split', async () => {
    const amount = await coinsOf(c, coin.mint, buyer.publicKey.toBase58()) / 3n
    const { op, chain, G, P, N, delivered } = await exactNativeSell(c, runtime, built.bundle, { token, wallet: buyer, coin, amount })
    t.diagnostic(`sell ${op.signature}: fee ${chain.fee}, G ${G} P ${P} N ${N}, delivered ${delivered}`)
  })
  await t.test('the same bootstrap with bundle 2 (config/hooklab-production-bundle-2.json) keeps native trading off', async () => {
    const file = path.join(ROOT, 'config/hooklab-production-bundle-2.json'), bytes = readFileSync(file), b2 = JSON.parse(bytes)
    const { runtime: off } = await bootRuntime(c, pool, bootEnv(file, bytes, b2.config.reviewer, b2.config.providerTrustDomains.map(x => x.origin)))
    assert.equal(off.nativeTrading, false)
    const id = randomUUID(), cap = JSON.parse(built.bundle.profile.json).capability
    await assert.rejects(off.lifecycle.createReview(token, id, { custodyOperationId: id, stage: 'native-buy', intent: { side: 'buy', creatorFeeBps: cap.creatorFeeBps, capBps: cap.defaultCapBps,
      mint: coin.mint, selectedConfig: coin.selectedConfig, amountIn: '1000003', minAmountOut: '1', maxInput: '1000003', maxPriceImpactBps: 1000, graduate: false } }), 'no native review under bundle 2')
    assert.deepEqual(c.blocked, [], 'nothing was sent anywhere but the local validator')
  })
})
