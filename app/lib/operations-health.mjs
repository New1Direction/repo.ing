import { PublicKey } from '@solana/web3.js'
import { AccountLayout } from '@solana/spl-token'
import journal from '../../drizzle/meta/_journal.json' with { type: 'json' }
import { chain, creatorSigner, database, partnerSigner } from './server.mjs'
import { OFFICIAL_TOKEN } from './official-token.mjs'
import { BUYBACK_WALLETS } from './buyback-receipts.mjs'
import { loadBuybackReceipts } from './buyback-receipts-db.mjs'
import { sumTokenAccountBalances } from './token-balance.mjs'
import { cspStats } from './csp-report.mjs'
import { healthWallets, loadOperationsHealth } from '../../src/operations-health.mjs'

// Signers are reduced to their public keys here; secret keys never leave server.mjs.
const publicAddress = read => { try { return read()?.publicKey.toBase58() ?? null } catch { return null } }

export function operationsHealth() {
  return loadOperationsHealth({
    db: database(),
    connection: process.env.SOLANA_RPC_URL || process.env.NODE_ENV !== 'production' ? { getBalance: address => chain().getBalance(new PublicKey(address), 'confirmed') } : null,
    wallets: () => healthWallets({ creator: publicAddress(creatorSigner), partner: publicAddress(partnerSigner), custody: BUYBACK_WALLETS.custody, team: OFFICIAL_TOKEN.teamWallet }),
    readToken: async owner => sumTokenAccountBalances((await chain().getTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(OFFICIAL_TOKEN.mint) },
      { commitment: 'confirmed', dataSlice: { offset: AccountLayout.offsetOf('amount'), length: 8 } })).value),
    loadBuybacks: () => loadBuybackReceipts(database()),
    cspStats: cspStats(),
    journal,
  })
}
