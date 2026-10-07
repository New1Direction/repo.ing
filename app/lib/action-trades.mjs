import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token'
import { prepareCheckedTrade } from '../../src/trade-prepare.mjs'
import { chain } from './server.mjs'
import { tradeRouter } from './trader.mjs'
import { STOCK_PAIR_ACTIONS_UNAVAILABLE } from './solana-actions.mjs'

// Solana Actions (Blink) trades: the site's canonical curve/graduated trader, the same balance + simulation preflight as
// /api/trade's prepare, and the trader's default 1% slippage. As on the site, a referral must never cost the trader a
// trade: anything that fails with one is retried once without it. A contributor early access market's trade (docs/EARLY_ACCESS.md)
// never carries a referral, so its refusals ("Contributor early access: …") are final too.
export async function prepareActionTrade(direction, request, { router = tradeRouter(), connection = chain() } = {}) {
  const engine = await router(request.githubRepoId)
  const build = async referrer => {
    const { prepared } = await prepareCheckedTrade({ engine, connection, direction, githubRepoId: request.githubRepoId,
      wallet: request.wallet, amountBaseUnits: direction === 'sell' ? request.amountBaseUnits : request.amountLamports, referrer })
    // Backstop to resolveMarket's refusal (app/lib/solana-actions.mjs): a stock-paired trade is never offered as a Blink.
    if (prepared.quoteMint) throw Error(STOCK_PAIR_ACTIONS_UNAVAILABLE)
    return prepared
  }
  const final = message => message === STOCK_PAIR_ACTIONS_UNAVAILABLE || message.startsWith('Contributor early access')
  try { return await build(request.referrer ?? null) }
  catch (error) { if (!request.referrer || final(String(error?.message))) throw error; return build(null) }
}

// A sell spends the wallet's associated token account, so that account's balance is what a sell percentage applies to.
// No account (or one that is not this wallet's for this mint) holds nothing to sell. token2022: a contributor early access market's
// token, whose associated account is under Token-2022.
export async function walletTokenBalance(owner, mint, connection = chain(), { token2022 = false } = {}) {
  const program = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  const address = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, program)
  const info = await connection.getAccountInfo(address, 'confirmed')
  if (!info?.owner.equals(program)) return 0n
  const account = unpackAccount(address, info, program)
  return account.mint.toBase58() === mint && account.owner.equals(owner) ? account.amount : 0n
}
