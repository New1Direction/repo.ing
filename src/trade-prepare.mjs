import { assertWalletAllowed, walletAddress } from './blocked-wallets.mjs'
import { estimateTradeCosts, preflightTrade } from './trade-costs.mjs'

// The one prepare path for a signable trade (site trade API, Solana Actions and the worker's trade canary): build through
// the canonical trader, estimate costs, and require the wallet to afford it and the unsigned transaction to simulate.
// slippageBps: undefined is the trader's 1% default; any other value is validated by the trader. The wallet goes on as its
// canonical address, the form a blocked wallet (src/blocked-wallets.mjs) is refused in, before anything is built.
export async function prepareCheckedTrade({ engine, connection, direction, githubRepoId, wallet, amountBaseUnits, referrer = null, slippageBps }) {
  if (direction !== 'buy' && direction !== 'sell') throw Error('Invalid trade direction')
  const address = walletAddress(wallet)
  if (!address) throw Error('Invalid trade wallet')
  assertWalletAllowed(address)
  const request = { githubRepoId, wallet: address, referrer: typeof referrer === 'string' ? referrer : null, slippageBps,
    [direction === 'sell' ? 'amountBaseUnits' : 'amountLamports']: amountBaseUnits }
  const prepared = await (direction === 'sell' ? engine.prepareSell(request) : engine.prepareBuy(request))
  const costs = await estimateTradeCosts(connection, prepared)
  await preflightTrade(connection, prepared, costs)
  return { prepared, costs }
}
