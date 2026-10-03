import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { quoteAssetById } from '../../src/quote-assets.mjs'
import { tokenAccountAmount } from '../../src/trade-costs.mjs'

// A wallet's balance of a stock pair's quote (docs/STOCK_QUOTES.md) in raw units, read from the associated Token-2022
// account a stock trade spends from, as { status, body } for /api/wallet/balance. No account is a zero balance; a failed
// read is unavailable, never zero. connect: () => Connection, called only for a known stock asset.
export async function stockBalance(connect, owner, assetId) {
  const asset = quoteAssetById(assetId)
  if (!asset || asset.type !== 'TOKENIZED_EQUITY') return { status: 400, body: { error: 'Unknown pair' } }
  let account
  try { account = getAssociatedTokenAddressSync(new PublicKey(asset.mint), owner, false, TOKEN_2022_PROGRAM_ID) }
  catch { return { status: 400, body: { error: 'Invalid wallet address' } } }
  try {
    const amount = await tokenAccountAmount(connect(), account, TOKEN_2022_PROGRAM_ID)
    return { status: 200, body: { assetId: asset.assetId, decimals: asset.decimals, balanceBaseUnits: amount.toString() } }
  } catch {
    return { status: 503, body: { error: `${asset.symbol} balance is temporarily unavailable` } }
  }
}
