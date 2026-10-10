import { Participation } from '../../../components/participation'
import { BuilderAllocation } from '../../../components/builder-allocation'
import Link from 'next/link'
import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { AppHeader, Footer, RepoIdentity, RepoStats, GitHubLink } from '../../../components/ui'
import { ClaimSteps } from '../../../components/claim-steps'
import { IconArt } from '../../../components/icon-art'
import { ClaimPageTips } from '../../../components/repo-tips'
import { ClaimPageDecision } from '../../../components/maintainer-declined'
import { ClaimBuilderTools } from '../../../components/builder-tools'
import { githubAppConfigurationUrl, githubInstallationForRepository } from '../../../../src/github-app-auth.mjs'
import { marketByRepo, feeStatus, database, chain, creatorSigner } from '../../../lib/server.mjs'
import { displayRepository } from '../../../lib/repository-display.mjs'
import { formatUnits, formatSolDisplay, formatUsdEstimate } from '../../../lib/format.mjs'
import { solUsdPrice } from '../../../lib/sol-usd.mjs'
import { githubSessionCookie, readGithubSession, seal } from '../../../lib/auth.mjs'
import { Connection } from '@solana/web3.js'
import { assertBuilderReinvestEnabled } from '../../../../src/builder-reinvest.mjs'
import { configAddress } from '../../../lib/server.mjs'
import { currentPayoutDestinations } from '../../../lib/payout-destination.mjs'
import { ModelClaimPage } from '../../../components/hf/claim-page'
import { StockPairClaimPage } from '../../../components/stock-pair-claim'
import { isStockPairMarket } from '../../../../src/stock-owner-claims.mjs'
import { nextClaimAmount } from '../../../../src/claim-amounts.mjs'
import { isEarlyAccessMarket } from '../../../../src/early-access.mjs'
import { creditsWebSettings } from '../../../../src/credits-web.mjs'
export const dynamic = 'force-dynamic'

export default async function ClaimPage({ params, searchParams }) {
  const { repo: repoId } = await params
  const query = await searchParams
  const { market } = await marketByRepo(repoId)
  if (!market) notFound()
  // A Hugging Face model market: its own claim flow (Hugging Face sign-in), never GitHub's.
  if (market.source === 'huggingface') return <ModelClaimPage market={market} query={query}/>
  // A stock-paired market: no owner claim (STOCK_PAIR_NO_OWNER_CLAIM), so none of the fee checks below run for it.
  if (isStockPairMarket(market)) return <StockPairClaimPage market={market} query={query}/>
  const repo = displayRepository(market)
  return <><AppHeader/><main className="section-wrap claim-page">
    <Link href={`/token/${market.mint}`} className="back-link"><ArrowLeft size={18}/>Back to repository</Link>
    <div className="claim-intro has-art"><div><h1>Claim builder fees</h1><Link href="/builders" className="claim-text-button">Claim across all your repositories →</Link><p>Verify your GitHub access, set a payout wallet, and receive your repository’s earnings.</p><small>Part of each trade fee is set aside for this repository, whether or not you’ve signed up.</small></div><IconArt name="earnings-wallet" size={132}/></div>
    <div className="claim-repo-card"><div><RepoIdentity repo={repo}/><RepoStats repo={repo}/></div><GitHubLink repo={repo}/></div>
    <Suspense fallback={<div className="inner-card claim-loading" role="status" aria-busy="true">Checking available fees and GitHub access…</div>}>
      <ClaimContent market={market} repo={repo} query={query}/>
    </Suspense>
    <Suspense fallback={null}><ClaimBuilderTools market={market}/></Suspense>
    <Suspense fallback={null}><ClaimTipsSection market={market}/></Suspense>
    <Participation repoId={repoId}/>
    <Suspense fallback={null}><ClaimPageDecision market={market}/></Suspense>
    {market.allocationVersion === 1 && <BuilderAllocation repoId={repoId}/>}
  </main><Footer/></>
}

async function ClaimTipsSection({ market }) {
  const session = readGithubSession((await cookies()).get(githubSessionCookie)?.value)
  return <ClaimPageTips market={market} session={session}/>
}

async function ClaimContent({ market, repo, query }) {
  const repoId = market.repoId, pool = database()
  const [fees, access, destination, receipt, usdPerSol, funded, cookieStore] = await Promise.all([
    feeStatus(repoId),
    githubInstallationForRepository({ owner: repo.owner, name: repo.name }).then(value => value ? 'installed' : 'missing').catch(() => 'unknown'),
    // The active binding (only it is ever paid) and a pasted address waiting out its hold.
    currentPayoutDestinations(pool, [repoId]).then(destinations => destinations.get(String(repoId)) ?? { active: null, pending: null }),
    pool.query(`select amount_base_units::text as amount, beneficiary_wallet as wallet, claim_signature as signature
      from repo_claims where github_repo_id = $1 and status = 'settled'
      and ($2::text is null or claim_signature = $2) order by settled_at desc limit 1`,
      [repoId, typeof query.claimed === 'string' ? query.claimed : null]).then(result => result.rows[0] ?? null),
    solUsdPrice(),
    (async () => { try { const signer = creatorSigner(); return Boolean(signer && await chain().getBalance(signer.publicKey, 'confirmed') > 0) } catch { return false } })(),
    cookies(),
  ])
  let appSettingsUrl = 'https://github.com/apps/repo-ing/installations/new'
  if (access === 'missing') {
    try { appSettingsUrl = await githubAppConfigurationUrl({ owner: repo.owner }) } catch {}
  }
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  // Only the public identity is passed to the UI; the GitHub credential stays encrypted and HttpOnly.
  const verifiedUser = session?.repoId === repoId ? { githubLogin: session.githubLogin, expiresAt: session.expiresAt } : null
  // What this claim pays. An early access market owed both curve and DAMM v2 fees pays the curve part now and the DAMM v2 part in
  // the next claim (docs/EARLY_ACCESS.md, step 7c); the summary says how much follows.
  const claimable = nextClaimAmount(fees)?.toString() ?? null
  const followsLater = claimable === null ? 0n : BigInt(fees.onchainCreatorFee) - BigInt(claimable)
  const beneficiary = destination.active
  // Who pasted a waiting address is shown to the verified admin of this repository only.
  const pendingAddress = destination.pending && (verifiedUser ? destination.pending : { ...destination.pending, requestedByLogin: null })
  const review = verifiedUser && beneficiary && claimable && claimable !== '0' ? seal({
    purpose: 'creator-claim-review', sessionId: session.sessionId, githubUserId: session.githubUserId,
    repoId, wallet: beneficiary.wallet, boundAt: new Date(beneficiary.boundAt).toISOString(),
    amount: claimable, includeGraduatedFees: fees.graduated === true, paid: market.claimed, expiresAt: Math.min(session.expiresAt, Date.now() + 10 * 60_000),
  }) : null
  const usdEstimate = claimable === null ? null : formatUsdEstimate(claimable, usdPerSol)
  let reinvestEnabled = false
  // Builder reinvest never takes an early access market (owner decision; src/builder-reinvest.mjs refuses it).
  if (verifiedUser && !isEarlyAccessMarket(market) && process.env.BUILDER_REINVEST_ENABLED === 'true' && process.env.BUILDER_REINVEST_VERIFICATION_RPC_URL) {
    try {
      await assertBuilderReinvestEnabled({pool, connection:chain(), verification:new Connection(process.env.BUILDER_REINVEST_VERIFICATION_RPC_URL,'finalized'), config:configAddress()})
      reinvestEnabled = true
    } catch { /* Production remains closed until the pinned P3 proof and both RPCs verify. */ }
  }
  // "Claim as AI credits" (src/credits-web.mjs): dark unless switched on; only for the verified admin.
  const credits = verifiedUser && database() ? creditsWebSettings() : null
  const summary = <div className="claim-amount-summary inner-card">
    <div><span>Available to claim</span><strong title={claimable === null ? undefined : `${formatUnits(claimable)} SOL`}>{claimable === null ? '—' : `${formatSolDisplay(claimable)} SOL`}</strong>{usdEstimate && <small>≈ {usdEstimate}</small>}</div>
    {followsLater > 0n && <p className="muted claim-follows">Then {formatSolDisplay(followsLater.toString())} SOL of graduated pool fees in a second claim: an early
      access payout claims its curve fees and its graduated pool fees one at a time.</p>}
    <div className="claim-fee-history"><span>Total earned <strong title={`${formatUnits(market.earned)} SOL`}>{formatSolDisplay(market.earned)} SOL</strong></span><span>Already paid <strong title={`${formatUnits(market.claimed)} SOL`}>{formatSolDisplay(market.claimed)} SOL</strong></span></div>
  </div>
  return <ClaimSteps summary={summary} repoId={repoId} mint={market.mint} repoName={repo.fullName} appAccess={access} appSettingsUrl={appSettingsUrl}
    verifiedUser={verifiedUser} beneficiaryWallet={beneficiary?.wallet ?? null} beneficiaryMethod={beneficiary?.method ?? 'signature'}
    beneficiaryBoundAt={beneficiary?.boundAt ?? null} pendingAddress={pendingAddress || null} claimable={claimable} usdEstimate={usdEstimate}
    feeStatus={fees.status} payoutReady={funded} settledClaim={receipt} review={review}
    reinvestEnabled={reinvestEnabled} reinvestAfterClaim={query.reinvest === '1'}
    creditsEnabled={Boolean(credits)} creditsAfterClaim={Boolean(credits) && query.credits === '1'} creditsNetwork={credits?.network ?? 'mainnet'}
    graduated={fees.graduated === true} justClaimed={typeof query.claimed === 'string' && receipt?.signature === query.claimed} errorCode={query.error || null}/>
}
