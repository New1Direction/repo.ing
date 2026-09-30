import { cache } from 'react'
import { readBackerNotes, readBackerRows, summarizeBackers } from '../../src/backers.mjs'
import { database, creatorSigner, partnerSigner } from './server.mjs'
import { OFFICIAL_TOKEN } from './official-token.mjs'
import { BUYBACK_WALLETS, PLATFORM_FEE_WALLET } from './buyback-receipts.mjs'
import { tipWalletAddress } from './tips.mjs'
import { xHandlesFor } from './x-links.mjs'

// Protected creator signer (per-pool creator and fee authority); also read from the env below when configured.
const CREATOR_SIGNER = 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1'
const publicKey = signer => { try { return signer()?.publicKey.toBase58() ?? null } catch { return null } }

// Wallets shown with a label instead of being counted: the repository's payout wallet, then repo.ing's own wallets
// (a platform label wins if the two ever coincide, e.g. the official token's team wallet).
export function backerLabels({ beneficiaryWallet, pool } = {}) {
  const labels = new Map()
  if (beneficiaryWallet) labels.set(beneficiaryWallet, { kind: 'builder', label: 'Builder' })
  const platform = [[OFFICIAL_TOKEN.teamWallet, 'team', 'repo.ing team'], [BUYBACK_WALLETS.custody, 'buyback', 'repo.ing buyback'],
    [PLATFORM_FEE_WALLET, 'buyback', 'repo.ing fee wallet'], [CREATOR_SIGNER, 'platform', 'repo.ing launch signer'],
    [publicKey(creatorSigner), 'platform', 'repo.ing launch signer'], [publicKey(partnerSigner), 'platform', 'repo.ing partner wallet'],
    [(() => { try { return tipWalletAddress() } catch { return null } })(), 'platform', 'repo.ing tip wallet'], [pool, 'platform', 'Pool account']]
  for (const [wallet, kind, label] of platform) if (wallet) labels.set(wallet, { kind, label })
  return labels
}

// One read per request (hero pill and Backers tab share it): one grouped SQL query, one holder-notes query for the
// listed wallets, one batched X-handle lookup. No RPC. null when the database is off or the read fails.
export const backersFor = cache(async (mint, pool, repoId, beneficiaryWallet) => {
  const db = database()
  if (!db) return null
  try {
    const summary = summarizeBackers(await readBackerRows(db, { pool, repoId }), { labels: backerLabels({ beneficiaryWallet, pool }) })
    const wallets = [...summary.top, ...summary.disclosed].map(row => row.wallet)
    const [notes, handles] = await Promise.all([readBackerNotes(db, mint, wallets).catch(() => new Map()), xHandlesFor(wallets).catch(() => new Map())])
    const decorate = row => ({ ...row, x: handles.get(row.wallet) ?? null, note: notes.get(row.wallet) ?? null })
    return { ...summary, top: summary.top.map(decorate), disclosed: summary.disclosed.map(decorate) }
  } catch (error) {
    console.error('backers unavailable', { mint, error: error.message })
    return null
  }
})

export const marketBackers = market => backersFor(market.mint, market.pool, market.repoId ?? null, market.beneficiaryWallet ?? null)
