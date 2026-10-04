import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js'
import { createDammTrader } from '../../src/canonical-damm-trade.mjs'

// A graduated trader run against a fixed pool account and a scripted chain: no RPC is touched, so every output (quote,
// prepared record, transaction bytes) is a pure function of the code. tests/damm-sol-golden.test.mjs compares the SOL outputs
// with tests/fixtures/damm-sol-golden.json, recorded from the trader before stock pairs were added to it.
const SYSVAR_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111')
const CP_AMM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')

export function scriptedChain({ accounts, unixTimestamp, slot, blockhash = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
  lastValidBlockHeight = 400_000_123, unitsConsumed = 61_234 }) {
  const clock = Buffer.alloc(40)
  clock.writeBigUInt64LE(BigInt(slot), 0)
  clock.writeBigInt64LE(BigInt(unixTimestamp), 32)
  const byAddress = new Map(accounts.map(account => [account.address, account]))
  const base = new Connection('http://127.0.0.1:1', 'confirmed')
  return Object.assign(Object.create(base), {
    getAccountInfo: async key => {
      const address = new PublicKey(key).toBase58()
      if (address === SYSVAR_CLOCK_PUBKEY.toBase58()) return { owner: SYSVAR_OWNER, data: clock, lamports: 1, executable: false }
      const found = byAddress.get(address)
      return found ? { owner: new PublicKey(found.owner), data: Buffer.from(found.data, 'base64'), lamports: 1, executable: false } : null
    },
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight }),
    simulateTransaction: async () => ({ value: { err: null, unitsConsumed, logs: [] } }),
    getRecentPrioritizationFees: async () => [{ slot, prioritizationFee: 250_000 }, { slot, prioritizationFee: 400_000 }],
  })
}

const swaps = JSON.parse(readFileSync(new URL('./repoing-damm-swaps.json', import.meta.url), 'utf8'))
const graduated = JSON.parse(readFileSync(new URL('./repoing-graduated-accounts.json', import.meta.url), 'utf8'))
const seeded = seed => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed) % 256)).publicKey
export const SOL_SCENARIO = Object.freeze({ config: seeded(1).toBase58(), curve: seeded(2).toBase58(), wallet: seeded(3).toBase58(),
  mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', pool: swaps.pool, marketId: 7, githubRepoId: 1388219884n })

// The SOL graduated trader's quotes and prepared records for a fixed wallet, pool and chain.
export async function solGraduatedOutputs() {
  const wallet = SOL_SCENARIO.wallet
  const pool = graduated.accounts.find(account => account.address === SOL_SCENARIO.pool)
  const connection = scriptedChain({ accounts: [{ ...pool, owner: CP_AMM.toBase58() }], unixTimestamp: 1790666590, slot: graduated.slot })
  const trader = createDammTrader({ pool: null, connection, config: SOL_SCENARIO.config,
    graduatedFees: { destination: async () => ({ target: new PublicKey(SOL_SCENARIO.pool) }) },
    loadMarket: async () => ({ id: SOL_SCENARIO.marketId, githubRepoId: SOL_SCENARIO.githubRepoId, mint: SOL_SCENARIO.mint, pool: SOL_SCENARIO.curve,
      status: 'confirmed', quoteAssetId: null, quoteMint: null }) })
  const githubRepoId = String(SOL_SCENARIO.githubRepoId)
  const quoteBuy = await trader.quoteBuy({ githubRepoId, amountLamports: '10000000', slippageBps: 100 })
  const quoteSell = await trader.quoteSell({ githubRepoId, amountBaseUnits: '10000000000', slippageBps: 250 })
  const buy = await trader.prepareBuy({ githubRepoId, wallet, amountLamports: '10000000', slippageBps: 100 })
  const sell = await trader.prepareSell({ githubRepoId, wallet, amountBaseUnits: '10000000000', slippageBps: 250 })
  const view = prepared => ({ record: prepared.record, amountIn: String(prepared.amountIn), minimumAmountOut: String(prepared.minimumAmountOut),
    phase: prepared.phase, quoteMint: prepared.quoteMint, referral: prepared.referral, pool: prepared.pool, mint: prepared.mint })
  return { quoteBuy, quoteSell, buy: view(buy), sell: view(sell) }
}
