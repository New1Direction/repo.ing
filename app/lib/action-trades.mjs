import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token'
import { prepareCheckedTrade } from '../../src/trade-prepare.mjs'
import { chain } from './server.mjs'
import { tradeRouter } from './trader.mjs'
import { STOCK_PAIR_ACTIONS_UNAVAILABLE } from './solana-actions.mjs'

// Solana Actions (Blink) trades: the site's canonical curve/graduated trader, the same balance + simulation preflight as
// /api/trade's prepare, and the trader's default 1% slippage. As on the site, a referral must never cost the trader a
// trade: anything that fails with one is retried once without it.
export async function prepareActionTrade(direction, request, { router = tradeRouter(), connection = chain() } = {}) {
  const engine = await router(request.githubRepoId)
  const build = async referrer => {
    const { prepared } = await prepareCheckedTrade({ engine, connection, direction, githubRepoId: request.githubRepoId,
      wallet: request.wallet, amountBaseUnits: direction === 'sell' ? request.amountBaseUnits : request.amountLamports, referrer })
    // Backstop to resolveMarket's refusal (app/lib/solana-actions.mjs): a stock-paired trade is never offered as a Blink.
    if (prepared.quoteMint) throw Error(STOCK_PAIR_ACTIONS_UNAVAILABLE)
    return prepared
  }
  try { return await build(request.referrer ?? null) }
  catch (error) { if (!request.referrer || error.message === STOCK_PAIR_ACTIONS_UNAVAILABLE) throw error; return build(null) }
}

// A sell spends the wallet's associated token account, so that account's balance is what a sell percentage applies to.
// No account (or one that is not this wallet's for this mint) holds nothing to sell.
export async function walletTokenBalance(owner, mint, connection = chain()) {
  const address = getAssociatedTokenAddressSync(new PublicKey(mint), owner)
  const info = await connection.getAccountInfo(address, 'confirmed')
  if (!info?.owner.equals(TOKEN_PROGRAM_ID)) return 0n
  const account = unpackAccount(address, info, TOKEN_PROGRAM_ID)
  return account.mint.toBase58() === mint && account.owner.equals(owner) ? account.amount : 0n
}
