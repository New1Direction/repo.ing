import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { CpAmm, SwapMode, getAmountWithSlippage } from '@meteora-ag/cp-amm-sdk'
import { scriptedChain, SOL_SCENARIO } from './fixtures/damm-trader-scenario.mjs'
import { REINVEST_RULES, reinvestQuote } from '../src/builder-reinvest-chain.mjs'

// Meteora's DAMM v2 SDK takes slippage in basis points (getQuote2 → getAmountWithSlippage(amount, slippageBps, mode)). Builder
// reinvest and protocol liquidity deployment passed maxSlippageBps / 100, so their reviewed 1% bound was applied as 0.01% and
// any price move between quote and execution reverted the transaction. These pin the units on the real SDK and the recorded
// REPOING pool (tests/fixtures/repoing-graduated-accounts.json), with no RPC.
const CP_AMM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'
const graduated = JSON.parse(readFileSync(new URL('./fixtures/repoing-graduated-accounts.json', import.meta.url), 'utf8'))

test("the DAMM v2 SDK's slippage argument is in basis points: 100 is 1%", () => {
  assert.equal(getAmountWithSlippage(new BN(10_000), 100, SwapMode.ExactIn).toString(), '9900')
})

test("builder reinvest's minimum swap output is the quoted output less exactly its reviewed slippage", async () => {
  const pool = graduated.accounts.find(account => account.address === SOL_SCENARIO.pool)
  // The SDK reads the pool with getAccountInfoAndContext, and getCurrentPoint reads the slot and, for a timestamp-activated pool,
  // its block time.
  const chain = scriptedChain({ accounts: [{ ...pool, owner: CP_AMM }], unixTimestamp: 1790666590, slot: graduated.slot })
  const connection = Object.assign(chain, { getSlot: async () => graduated.slot, getBlockTime: async () => 1790666590,
    getAccountInfoAndContext: async key => ({ context: { slot: graduated.slot }, value: await chain.getAccountInfo(key) }) })
  const amm = new CpAmm(connection)
  const state = await amm.fetchPoolState(new PublicKey(SOL_SCENARIO.pool))
  const quote = await reinvestQuote(connection, { amm, state }, 20_000_000n)
  const output = BigInt(quote.outputAmount), minA = BigInt(quote.minA)
  assert.equal(REINVEST_RULES.maxSlippageBps, 100)
  assert.ok(output > 0n)
  assert.equal(minA, output * BigInt(10_000 - REINVEST_RULES.maxSlippageBps) / 10_000n, '1% below the quoted output, not 0.01%')
  // The deposit is sized from that minimum, so it always fits whatever the swap returns within the bound.
  assert.ok(BigInt(quote.liquidity) > 0n && BigInt(quote.minimumLiquidity) <= BigInt(quote.liquidity))
})

test('protocol liquidity deployment passes its reviewed slippage to the SDK in basis points too', () => {
  for (const file of ['../src/liquidity-deployment.mjs', '../src/builder-reinvest-chain.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(source, /slippage:rules\.maxSlippageBps,/, file)
    assert.doesNotMatch(source, /maxSlippageBps\s*\/\s*100/, file)
  }
})
