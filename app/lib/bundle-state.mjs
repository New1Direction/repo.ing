import { backerShareBps, pendingBackerFees } from '../../src/bundle-vault.mjs'
import { STATUS_NAMES } from '../../src/bundle-raise.mjs'
import { createBackerCounter, readBacker, readBundle } from '../../src/bundle-raise-chain.mjs'
import { loadBundle } from '../../src/bundle-raise-store.mjs'

// A bundle as the raise page, its API and the token page show it (docs/BUNDLE_LAUNCH.md): the site's row (repository, token,
// the site's own step) and the chain's Bundle account, which is the truth for the raise, the deadline, the status and the
// routed fees. JSON-safe: lamports and shares as strings, times as ISO strings. The token image is read where it is shown.

const iso = seconds => seconds ? new Date(seconds * 1000).toISOString() : null
const text = value => value === null || value === undefined ? null : value.toString()

function chainJson(bundle) {
  if (!bundle) return null
  const launched = STATUS_NAMES[bundle.status] === 'launched'
  return { status: STATUS_NAMES[bundle.status] ?? 'unknown', raised: text(bundle.raised), target: text(bundle.target), minDeposit: text(bundle.minDeposit),
    deadline: iso(bundle.deadline), refunded: text(bundle.refunded), graduated: bundle.graduated, paused: bundle.paused,
    mint: launched ? bundle.mint.toBase58() : null, launchedAt: iso(bundle.launchedAt), tradingOpensAt: iso(bundle.tradingOpensAt),
    backerBps: bundle.backerBps, opsBps: bundle.opsBps, vaultVolume: text(bundle.vaultVolume), vaultRebated: text(bundle.vaultRebated), backerIncome: text(bundle.backerIncome),
    backerPaid: text(bundle.backerPaid), treasuryIncome: text(bundle.treasuryIncome) }
}

// A wallet's place in a bundle: its shares (one per lamport deposited), what it was paid, what it can claim now and its share.
export const backerJson = (bundle, backer) => backer && bundle ? { shares: text(backer.shares), paid: text(backer.paid),
  pending: text(pendingBackerFees(bundle, backer)), shareBps: backerShareBps(bundle, backer) } : null

export function bundleJson({ row, bundle, backers = null, backer = null, wallet = null, now = Date.now() }) {
  return { id: row.bundleId, address: row.address, repoId: row.githubRepoId, fullName: row.fullName, owner: row.owner, name: row.name,
    avatarUrl: row.avatarUrl, description: row.description ?? null, tokenName: row.tokenName, tokenSymbol: row.tokenSymbol,
    creatorWallet: row.creatorWallet, siteStatus: row.status, createSignature: row.createSignature ?? null, marketMint: row.marketMint ?? null,
    terms: { target: row.targetLamports, minDeposit: row.minDepositLamports, deadline: new Date(row.deadline).toISOString() },
    chain: chainJson(bundle), backers, wallet: wallet ? { address: wallet.toBase58(), backer: backerJson(bundle, backer) } : null,
    checkedAt: new Date(now).toISOString() }
}

// The raise page and the token page share one backer count per bundle per 30 s (the API keeps its own, app/lib/bundle-api.mjs).
const sharedBackerCount = createBackerCounter()

// The site's row, then the chain (the account, its backer count and the wallet's backer account, read together); null when the
// site never opened this bundle. wallet: a PublicKey or null.
export async function readBundleState({ pool, connection, id, wallet = null, countBackers = sharedBackerCount }) {
  const row = await loadBundle(pool, id)
  if (!row) return null
  const [bundle, backers, backer] = await Promise.all([readBundle(connection, id), countBackers(connection, id),
    wallet ? readBacker(connection, id, wallet) : null])
  return bundleJson({ row, bundle, backers, backer, wallet })
}
