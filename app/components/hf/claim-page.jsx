import Link from 'next/link'
import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { ArrowLeft } from 'lucide-react'
import { AppHeader, Footer } from '../ui'
import { ModelClaimSteps } from './claim-steps'
import { HF_DISCLAIMER } from '../../../src/hf-copy.mjs'
import { hfModelUrl, isHfModelPath } from '../../../src/hf-url.mjs'
import { HfAuthorityError, hfMarketsEnabled } from '../../../src/hf-verification.mjs'
import { chain, creatorSigner, database, feeStatus } from '../../lib/server.mjs'
import { formatSolDisplay, formatUnits, formatUsdEstimate } from '../../lib/format.mjs'
import { solUsdPrice } from '../../lib/sol-usd.mjs'
import { currentPayoutDestinations } from '../../lib/payout-destination.mjs'
import { hfSessionCookie, publicHfUser, readHfSession, sealHfClaimReview } from '../../lib/hf-auth.mjs'
import { hfVerifier } from '../../lib/hf-session.mjs'
import styles from './model-authority.module.css'

// The claim page of a Hugging Face model market: the early return in app/(site)/claim/[repo]/page.jsx. Sign in with
// Hugging Face, set a payout wallet, claim. Nothing here authorizes anything: /api/hf/bind and /api/hf/claim check the
// model's current owner again before every change and payout. No Hugging Face logo, and the disclaimer on the page.
export function ModelClaimPage({ market, query }) {
  return <><AppHeader/><main className="section-wrap claim-page">
    <Link href={`/token/${market.mint}`} className="back-link"><ArrowLeft size={18}/>Back to model</Link>
    <div className="claim-intro"><div><h1>Claim model fees</h1>
      <p>Sign in with Hugging Face, set a payout wallet, and receive this model’s earnings.</p>
      <small>Part of each trade fee is set aside for the model’s current owner on Hugging Face, whether or not they’ve signed up.</small></div></div>
    <p className={styles.disclaimer} role="note">{HF_DISCLAIMER}</p>
    <Suspense fallback={<div className="inner-card claim-loading" role="status" aria-busy="true">Checking available fees and Hugging Face access…</div>}>
      <ModelClaimContent market={market} query={query}/>
    </Suspense>
  </main><Footer/></>
}

async function registryModel(pool, repoId) {
  try {
    const { rows: [row] } = await pool.query(`select repo_path as path, owner_handle as "ownerHandle", owner_kind as "ownerKind"
      from hf_models where market_ref = $1`, [repoId])
    return row ?? null
  } catch { return null }
}

function ModelCard({ market, model }) {
  const path = model?.path ?? market.fullName
  return <div className="claim-repo-card"><div>
    <div className="eyebrow">HUGGING FACE MODEL</div>
    <h2>{path}</h2>
    {model && <p className="muted">Owned by {model.ownerHandle} ({model.ownerKind === 'org' ? 'an organization' : 'a user'}) when Hugging Face was last checked.</p>}
  </div>{isHfModelPath(path) && <a className="button outline github-link" href={hfModelUrl(path)} target="_blank" rel="noopener noreferrer">View on Hugging Face ↗</a>}</div>
}

// For display only: no second model read and no registry write, and remembered per session, market and registry path
// (a re-point changes the path) for a minute (15 s when it failed), so page views and refreshes cannot spend the shared
// Hugging Face budget. Every change and payout re-checks in full.
const STATUS_TTL_MS = 60_000, STATUS_FAILED_TTL_MS = 15_000, STATUS_ENTRIES = 500
const statuses = globalThis.__repoingHfAuthorityStatus ??= new Map()
async function checkAuthority(session, repoId) {
  try {
    const result = await hfVerifier().verifyMarketAuthority({ marketId: repoId, accessToken: session.accessToken, expectedSubject: session.subject,
      record: false, recheck: false, update: false })
    return { ok: true, role: result.role, ownerHandle: result.ownerHandle, ownerKind: result.ownerKind, ownerSubject: result.ownerSubject }
  } catch (error) {
    return { ok: false, code: error instanceof HfAuthorityError ? error.code : 'HF_UPSTREAM',
      message: error instanceof HfAuthorityError ? error.message : 'Hugging Face could not be checked right now. Refresh to try again.' }
  }
}
async function authorityStatus(session, repoId, path) {
  const key = `${session.sessionId}:${repoId}:${path ?? ''}`, now = Date.now(), hit = statuses.get(key)
  if (hit && hit.expiresAt > now) return hit.value
  const value = await checkAuthority(session, repoId)
  if (statuses.size >= STATUS_ENTRIES) statuses.delete(statuses.keys().next().value)
  statuses.set(key, { value, expiresAt: now + (value.ok ? STATUS_TTL_MS : STATUS_FAILED_TTL_MS) })
  return value
}

async function ModelClaimContent({ market, query }) {
  const repoId = market.repoId, pool = database()
  const model = pool ? await registryModel(pool, repoId) : null
  const card = <ModelCard market={market} model={model}/>
  if (!hfMarketsEnabled() || !pool) {
    return <>{card}<section className="inner-card" aria-labelledby="model-claims-closed"><h2 id="model-claims-closed">Model claims are not open yet</h2>
      <p>Fees this model earns stay set aside in its pool. Claims open here once Hugging Face sign-in is enabled.</p></section></>
  }
  const [fees, destination, bindingOwner, receipt, usdPerSol, funded, cookieStore] = await Promise.all([
    feeStatus(repoId),
    currentPayoutDestinations(pool, [repoId]).then(destinations => destinations.get(String(repoId)) ?? { active: null, pending: null }),
    pool.query('select authority_owner_subject as "ownerSubject" from repo_beneficiaries where github_repo_id = $1', [repoId])
      .then(result => result.rows[0]?.ownerSubject ?? null).catch(() => null),
    pool.query(`select amount_base_units::text as amount, beneficiary_wallet as wallet, claim_signature as signature
      from repo_claims where github_repo_id = $1 and status = 'settled'
      and ($2::text is null or claim_signature = $2) order by settled_at desc limit 1`,
    [repoId, typeof query.claimed === 'string' ? query.claimed : null]).then(result => result.rows[0] ?? null).catch(() => null),
    solUsdPrice(),
    (async () => { try { const signer = creatorSigner(); return Boolean(signer && await chain().getBalance(signer.publicKey, 'confirmed') > 0) } catch { return false } })(),
    cookies(),
  ])
  const stored = readHfSession(cookieStore.get(hfSessionCookie)?.value)
  const session = stored?.mode === 'claim' && stored.marketId === String(repoId) ? stored : null
  const authority = session ? await authorityStatus(session, repoId, model?.path) : null
  const beneficiary = destination.active
  // A binding made for a previous owner is never paid (src/claim.mjs); the current owner sets a new one first.
  const staleBinding = Boolean(beneficiary && authority?.ok && bindingOwner && bindingOwner !== authority.ownerSubject)
  const claimable = fees.status === 'MATCH' ? fees.onchainCreatorFee?.toString() ?? null : null
  const review = session && authority?.ok && !staleBinding && beneficiary && claimable && claimable !== '0'
    ? sealHfClaimReview(session, { repoId, wallet: beneficiary.wallet, boundAt: beneficiary.boundAt, amount: claimable, paid: market.claimed,
      includeGraduatedFees: fees.graduated === true }) : null
  const usdEstimate = claimable === null ? null : formatUsdEstimate(claimable, usdPerSol)
  const summary = <div className="claim-amount-summary inner-card">
    <div><span>Available to claim</span><strong title={claimable === null ? undefined : `${formatUnits(claimable)} SOL`}>{claimable === null ? '—' : `${formatSolDisplay(claimable)} SOL`}</strong>{usdEstimate && <small>≈ {usdEstimate}</small>}</div>
    <div className="claim-fee-history"><span>Total earned <strong title={`${formatUnits(market.earned)} SOL`}>{formatSolDisplay(market.earned)} SOL</strong></span><span>Already paid <strong title={`${formatUnits(market.claimed)} SOL`}>{formatSolDisplay(market.claimed)} SOL</strong></span></div>
  </div>
  const pendingAddress = destination.pending && (authority?.ok ? destination.pending : { ...destination.pending, requestedByLogin: null })
  return <>{card}<ModelClaimSteps summary={summary} repoId={String(repoId)} signedIn={publicHfUser(session)}
    authority={authority && { ok: authority.ok, role: authority.role ?? null, ownerHandle: authority.ownerHandle ?? null, ownerKind: authority.ownerKind ?? null,
      code: authority.code ?? null, message: authority.message ?? null }}
    beneficiaryWallet={beneficiary?.wallet ?? null} beneficiaryMethod={beneficiary?.method ?? 'signature'} beneficiaryBoundAt={beneficiary?.boundAt ?? null}
    staleBinding={staleBinding} pendingAddress={pendingAddress || null} claimable={claimable} usdEstimate={usdEstimate} feeStatus={fees.status}
    payoutReady={funded} settledClaim={receipt} review={review} graduated={fees.graduated === true} errorCode={typeof query.error === 'string' ? query.error : null}
    justClaimed={typeof query.claimed === 'string' && receipt?.signature === query.claimed}/></>
}
