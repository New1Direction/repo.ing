import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection, Keypair, sendAndConfirmTransaction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import { createFixedConfig } from './fixed-config.mjs'
import { buildLaunchCurve } from '../src/launch-curve.mjs'
import { quoteDisplay } from '../src/trade-quote-display.mjs'

const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
const connection = new Connection(rpc, 'confirmed')
const dbc = new DynamicBondingCurveClient(connection, 'confirmed')

for (const profile of ['legacy', 'balanced', 'builders', 'deeper', 'deepest']) test(`${profile}: SDK quotes execute exactly and all purchased tokens can sell back`, async () => {
  const { config, partner } = await createFixedConfig(connection, profile)
  const trader = Keypair.generate(), mint = Keypair.generate()
  const airdrop = await connection.requestAirdrop(trader.publicKey, 20_000_000_000)
  await connection.confirmTransaction({ signature: airdrop, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config)
  const send = async (tx, signers) => {
    tx.feePayer = signers[0].publicKey
    return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
  }
  await send(await dbc.creator.createPool({ baseMint: mint.publicKey, config, name: `Curve ${profile}`, symbol: 'CURVE',
    uri: 'https://example.com/local-only.json', payer: trader.publicKey, poolCreator: partner.publicKey }), [trader, partner, mint])
  const fixed = await dbc.state.getPoolConfig(config)
  assert.equal(fixed.migrationQuoteThreshold.toString(), buildLaunchCurve(profile).migrationQuoteThreshold.toString())
  const ata = getAssociatedTokenAddressSync(mint.publicKey, trader.publicKey)
  const rows = []
  for (const input of ['100000000', '1000000000', '5000000000']) {
    const state = await dbc.state.getPool(pool)
    assert.ok(state.poolState.quoteReserve.lten(10), 'round trip restores real quote reserves to rounding dust')
    const quote = dbc.pool.swapQuote({ virtualPool: state, config: fixed, swapBaseForQuote: false,
      amountIn: new BN(input), slippageBps: 0, hasReferral: false, eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN(Math.floor(Date.now() / 1000)) })
    const fee = quote.tradingFee.add(quote.protocolFee).add(quote.referralFee)
    const buy = await send(await dbc.pool.swap({ owner: trader.publicKey, payer: trader.publicKey, pool,
      amountIn: new BN(input), minimumAmountOut: quote.outputAmount, swapBaseForQuote: false, referralTokenAccount: null }), [trader])
    assert.equal((await getAccount(connection, ata)).amount.toString(), quote.outputAmount.toString())
    const bought = await dbc.state.getPool(pool)
    assert.equal(bought.poolState.quoteReserve.sub(state.poolState.quoteReserve).toString(), new BN(input).sub(fee).toString())
    const sellQuote = dbc.pool.swapQuote({ virtualPool: bought, config: fixed, swapBaseForQuote: true,
      amountIn: quote.outputAmount, slippageBps: 0, hasReferral: false, eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN(Math.floor(Date.now() / 1000)) })
    const sell = await send(await dbc.pool.swap({ owner: trader.publicKey, payer: trader.publicKey, pool,
      amountIn: quote.outputAmount, minimumAmountOut: sellQuote.outputAmount, swapBaseForQuote: true, referralTokenAccount: null }), [trader])
    assert.equal((await getAccount(connection, ata)).amount, 0n)
    assert.ok((await dbc.state.getPool(pool)).poolState.quoteReserve.lten(10))
    const roundTrip = Number(sellQuote.outputAmount.toString()) / Number(input)
    assert.ok(Math.abs(roundTrip - 0.9825 ** 2) < 0.000001, 'round trip loses only two fixed fees and integer dust, excluding network costs')
    rows.push({ input, output: quote.outputAmount.toString(), sellOutput: sellQuote.outputAmount.toString(),
      ...quoteDisplay({ direction: 'buy', input, output: quote.outputAmount.toString(),
        sqrtPrice: state.poolState.sqrtPrice.toString(), fee: fee.toString() }), buy, sell })
  }
  console.log(JSON.stringify({ profile, config: config.toBase58(), pool: pool.toBase58(), rows }))
})
