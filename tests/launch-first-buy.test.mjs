import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { canonicalTradeEvents } from '../src/trade-evidence.mjs'
import { launchBuyPreset, launchBuyQuote } from '../src/launch-buy.mjs'
import { estimateLaunchCosts } from '../src/launch-costs.mjs'

for (const profile of ['legacy', 'balanced', 'builders']) test(`${profile}: first buy is atomic, bounded to 3%, and yields a chart trade`, async () => {
  const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
  assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
  const connection = new Connection(rpc, 'confirmed')
  const { config } = await createFixedConfig(connection, profile)
  const creator = Keypair.generate()
  const payer = Keypair.generate()
  const airdrop = await connection.requestAirdrop(payer.publicKey, 2_000_000_000)
  await connection.confirmTransaction({ signature: airdrop, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  const launcher = createMeteoraLauncher({ connection, config, creator })
  const request = { launcherWallet: payer.publicKey.toBase58(), tokenName: 'First Buy', tokenSymbol: 'FIRST' }
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const fixed = await dbc.state.getPoolConfig(config)
  for (const bps of [100, 200, 300]) {
    const amount = launchBuyPreset(dbc, fixed, bps)
    const target = 1_000_000_000_000_000n * BigInt(bps) / 10_000n
    const quote = launchBuyQuote(dbc, fixed, amount)
    assert.ok(BigInt(quote.outputAmount.toString()) <= target)
    if (bps < 300) assert.ok(BigInt(launchBuyQuote(dbc, fixed, (BigInt(amount) + 1n).toString()).outputAmount.toString()) > target)
    else assert.throws(() => launchBuyQuote(dbc, fixed, (BigInt(amount) + 1n).toString()), /exceeds 3%/)
    assert.ok(BigInt(quote.tradingFee.toString()) > 0n)
  }
  assert.equal(launchBuyQuote(dbc, fixed, '0'), null)
  assert.throws(() => launchBuyPreset(dbc, fixed, 400), /Choose/)
  await assert.rejects(() => launcher.prepare({ ...request, initialBuyLamports: '5000000000' }), /exceeds 3%/)
  const initialBuyLamports = launchBuyPreset(dbc, fixed, 300)
  const prepared = await launcher.prepare({ ...request, initialBuyLamports })
  assert.ok(BigInt(prepared.initialBuyOutput) > 0n)
  assert.ok(BigInt(prepared.initialBuyOutput) <= 30_000_000_000_000n)
  let costs
  const signed = await prepared.sign(async tx => {
    costs = await estimateLaunchCosts(connection, tx, initialBuyLamports)
    tx.partialSign(payer); return tx
  })
  assert.equal(costs.initialBuy, initialBuyLamports)
  assert.ok(BigInt(costs.accountDeposits) > 0n)
  const before = await connection.getBalance(payer.publicKey, 'confirmed')
  await launcher.submit({ ...signed, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight })
  const after = await connection.getBalance(payer.publicKey, 'confirmed')
  assert.equal(BigInt(before - after).toString(), costs.total, 'simulated total equals the actual wallet debit')
  assert.equal(await launcher.inspect({ ...prepared, launchSignature: signed.signature }), true)
  const account = await getAccount(connection, getAssociatedTokenAddressSync(new PublicKey(prepared.mint), payer.publicKey))
  assert.equal(account.amount.toString(), prepared.initialBuyOutput)
  let tx
  for (let i = 0; i < 80 && !tx; i++) {
    tx = await connection.getTransaction(signed.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (!tx) await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(tx, 'launch and first buy must finalize')
  assert.equal(String(tx.meta.fee), costs.networkFee)
  const events = canonicalTradeEvents(tx, { mint: prepared.mint, pool: prepared.pool, signature: signed.signature }, config, dbc)
  assert.equal(events.length, 1)
  assert.equal(events[0].direction, 'buy')
  assert.equal(events[0].outputBaseUnits, prepared.initialBuyOutput)
  assert.ok(BigInt(events[0].nextSqrtPrice) > 0n)
})
