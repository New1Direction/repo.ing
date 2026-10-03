import { Suspense } from 'react'
import Link from 'next/link'
import { Ban, BadgeCheck, CalendarClock, CircleDashed, Coins, Info, PieChart, Rocket, Sprout, Timer } from 'lucide-react'
import { LAUNCH_FEE_SPLIT, launcherBuySentence, launchFeeSentence } from '../../src/launch-fee-copy.mjs'
import { hasXHandle } from './x-handle-link'
import { WalletIdentity } from './wallet-identity'
import { xHandleFor } from '../lib/x-links.mjs'
import { holderSnapshot, launcherSummary } from '../lib/trust-panel.mjs'
import { graduationLabel, launcherLines, maintainerStatus, percentLabel, TOP_HOLDERS } from '../../src/trust-signals.mjs'
import { holdingLabel, shortWallet } from '../lib/holder-note-format.mjs'
import { REPO_FACTS_TIP } from '../lib/repo-quality.mjs'
import { signedPayoutWallet } from '../lib/official-launch.mjs'
import { isModelMarket } from '../lib/hf-model-display.mjs'

// One fact per row: icon, a one-line headline, fixed-height detail lines, and a one-line explainer behind (i).
// Streamed rows keep the same line count while loading, so the card never changes height.
function Row({ id, icon: Icon, tone = 'neutral', title, lines, tip, busy = false }) {
  return <li className={`trust-row is-${tone}`} aria-busy={busy || undefined}>
    <span className="trust-icon" aria-hidden="true"><Icon size={17}/></span>
    <div className="trust-copy">
      <strong className="trust-title">{busy ? <span className="skeleton-text"/> : title}</strong>
      {lines.map((line, index) => <span key={index} className="trust-line">{busy ? <span className="skeleton-text"/> : line}</span>)}
    </div>
    <span className="trust-tip">
      <button type="button" className="trust-tip-button" aria-label="What this means" aria-describedby={`${id}-tip`}><Info size={14} aria-hidden="true"/></button>
      <span role="tooltip" id={`${id}-tip`} className="trust-tip-text">{tip}</span>
    </span>
  </li>
}

const TIPS = {
  maintainer: 'Verified: a GitHub admin of this repository signed in and verified it on repo.ing, so builder fees can reach them.',
  launcher: 'From buys and sells on repo.ing (bonding curve and graduated pool). Tokens moved by transfer are not counted.',
  holders: `On-chain: the ${TOP_HOLDERS} largest wallets' share of supply. The bonding curve or pool vault and token locks are shown separately, not counted. Refreshed about every minute.`,
  token: 'Read from the token mint account on Solana. With the mint authority revoked, no more tokens can ever be minted.',
  declined: 'A current GitHub admin of this repository declined this market on repo.ing. repo.ing does not promote it. Trading stays open so holders can exit, and builder fees stay claimable by the maintainer.',
  modelOwner: "Verified: the model's current owner on Hugging Face (the user, or an admin of the owning organization) signed in and verified it on repo.ing, so fees can reach them.",
  modelDeclined: "The model's current owner on Hugging Face declined this market on repo.ing. repo.ing does not promote it. Trading stays open so holders can exit, and fees stay claimable by the owner.",
}

// Hugging Face model markets: the owner is the model's current Hugging Face owner, and claiming starts on /claim/<id>.
function ModelOwnerRow({ market }) {
  const { verified } = maintainerStatus(market)
  return verified
    ? <Row id="trust-maintainer" icon={BadgeCheck} tone="verified" title="Verified model owner ✓"
      lines={[market.beneficiaryWallet ? 'Hugging Face owner verified · payout wallet set' : 'Hugging Face owner verified']} tip={TIPS.modelOwner}/>
    : <Row id="trust-maintainer" icon={CircleDashed} title="Model owner hasn't verified yet"
      lines={[<>Model owner? <Link href={`/claim/${market.repoId}`}>Claim as the model&apos;s owner →</Link></>]} tip={TIPS.modelOwner}/>
}

function MaintainerRow({ market }) {
  const { verified } = maintainerStatus(market)
  return verified
    ? <Row id="trust-maintainer" icon={BadgeCheck} tone="verified" title="Verified maintainer ✓"
      lines={[market.beneficiaryWallet ? 'GitHub admin verified · payout wallet set' : 'GitHub admin verified']} tip={TIPS.maintainer}/>
    : <Row id="trust-maintainer" icon={CircleDashed} title="Maintainer hasn't verified yet"
      lines={[<>Maintainer? <Link href={`/claim/${market.repoId}`}>Verify here →</Link></>]} tip={TIPS.maintainer}/>
}

// facts: repoFactsView (repo-quality.mjs). Age and stars, then the repo score, for every market; the warning tone only
// while a new repository's market has not earned promotion.
function RepoRow({ facts }) {
  return <Row id="trust-repo" icon={facts.labeled ? Sprout : CalendarClock} tone={facts.tone} title={facts.title}
    lines={[facts.counts, <span key="score" title={facts.scoreDetail}>{facts.scoreLabel}</span>]} tip={REPO_FACTS_TIP}/>
}

const launcherRow = props => <Row id="trust-launcher" icon={Rocket} tip={TIPS.launcher} {...props}/>
const LauncherFallback = () => launcherRow({ busy: true, lines: [null, null, null] })

async function LauncherRow({ market }) {
  const signed = signedPayoutWallet(market)
  const summary = await launcherSummary(market.mint, market.launcherWallet ?? null, signed, market.pool)
  const lines = launcherLines(summary?.position)
  if (!summary || !lines) return launcherRow({ title: 'Launcher position unavailable', lines: ['', '', ''] })
  // Only a wallet-signed payout wallet says the launcher is the maintainer; a pasted one is named as what it is.
  const ownWallet = Boolean(signed) && summary.wallet === signed
  const pastedPayout = !ownWallet && Boolean(market.beneficiaryWallet) && summary.wallet === market.beneficiaryWallet
  const label = ownWallet ? (isModelMarket(market) ? "Owner's payout wallet" : "Maintainer's payout wallet") : pastedPayout ? 'Pasted payout address' : summary.label?.kind === 'builder' ? null : summary.label?.label
  // A launcher who linked X is shown as that account; otherwise the short address, linking to Solscan.
  const link = await xHandleFor(summary.wallet).catch(() => null)
  const who = <span className="trust-who">
    {hasXHandle(link) ? <WalletIdentity wallet={summary.wallet} link={link} trust={ownWallet} className="trust-x"/>
      : <a href={`https://solscan.io/account/${summary.wallet}`} target="_blank" rel="noreferrer" title={summary.wallet}>
        <code>{shortWallet(summary.wallet)}</code><span className="sr-only"> (view on Solscan)</span></a>}
    {label && <span className="trust-label">{label}</span>}
  </span>
  return launcherRow({ title: lines.title, lines: [who, lines.launch, lines.sold] })
}

const holdersRow = props => <Row id="trust-holders" icon={PieChart} tip={TIPS.holders} {...props}/>
const tokenRow = props => <Row id="trust-token" icon={Coins} tip={TIPS.token} {...props}/>
const HoldersFallback = () => <>{holdersRow({ busy: true, lines: [null] })}{tokenRow({ busy: true, lines: [null, null] })}</>

function vaultLine(holders) {
  const parts = []
  if (holders.curvePercent) parts.push(`${percentLabel(holders.curvePercent)} in the curve`)
  if (holders.poolPercent) parts.push(`${percentLabel(holders.poolPercent)} in the pool`)
  if (holders.lockedPercent) parts.push(`${percentLabel(holders.lockedPercent)} locked`)
  return parts.length ? parts.join(' · ') : 'Nothing in the curve, pool or locks'
}

// Token row: mint authority as the headline, then supply (and any burned since launch), then graduation status.
const tokenTitle = mint => mint.mintAuthorityRevoked ? 'Mint authority revoked' : 'Mint authority active: more can be minted'
function supplyLine(mint) {
  if (mint.fixedSupply) return '1B fixed supply'
  return mint.burnedBaseUnits !== '0' ? `1B supply · ${holdingLabel(mint.burnedBaseUnits)} burned` : 'Supply differs from 1B'
}

async function HoldersRows({ market }) {
  const snapshot = await holderSnapshot(market)
  const graduation = graduationLabel(market)
  if (!snapshot?.holders || !snapshot.mint) return <>
    {holdersRow({ title: 'Holder data unavailable right now', lines: ['On-chain read failed; try again shortly'] })}
    {tokenRow({ title: 'Mint details unavailable right now', lines: ['1B supply at launch', graduation] })}</>
  const { holders, mint } = snapshot
  return <>
    {holdersRow({ title: `Top ${holders.topCount || TOP_HOLDERS} holders own ${percentLabel(holders.topPercent)}`, lines: [vaultLine(holders)] })}
    {tokenRow({ title: tokenTitle(mint), lines: [supplyLine(mint), graduation] })}
  </>
}

// Only for markets whose on-chain config has the launch fee (launchFee: launchFeeTerms of the market's config).
function LaunchFeeRow({ terms }) {
  return <Row id="trust-launch-fee" icon={Timer} title={`Launch fee: first ${terms.durationLabel}`}
    lines={[`${terms.startPercent} at launch, falling every second to ${terms.endPercent}`, 'Split like the regular fee']}
    tip={[launchFeeSentence(terms), LAUNCH_FEE_SPLIT, launcherBuySentence(terms),
      'It makes buying in the first seconds and selling to later buyers costly.'].filter(Boolean).join(' ')}/>
}

// Token page trust panel: who maintains it, how established the repository is, what the launcher did, how concentrated
// holdings are, and the mint facts. The maintainer and repository rows are known at render time; the rest stream in
// without changing the card's height. declined: the maintainer's active decline (src/maintainer-opt-outs.mjs), or null.
// repoFacts: repoFactsView (repo-quality.mjs).
export function TrustPanel({ market, launchFee = null, declined = null, repoFacts = null }) {
  const model = isModelMarket(market)
  return <section className="inner-card trust-panel" aria-labelledby="trust-panel-title">
    <div className="trust-heading"><h3 id="trust-panel-title">Launch facts</h3><span>On-chain and repo.ing data</span></div>
    <ul className="trust-rows">
      {model ? <ModelOwnerRow market={market}/> : <MaintainerRow market={market}/>}
      {declined && (model
        ? <Row id="trust-declined" icon={Ban} tone="declined" title="Model owner declined this market" lines={["Not promoted · not endorsed by the model's creators"]} tip={TIPS.modelDeclined}/>
        : <Row id="trust-declined" icon={Ban} tone="declined" title="Maintainer declined this market" lines={['Not promoted · not endorsed by the project']} tip={TIPS.declined}/>)}
      {repoFacts && <RepoRow facts={repoFacts}/>}
      {launchFee && <LaunchFeeRow terms={launchFee}/>}
      <Suspense fallback={<LauncherFallback/>}><LauncherRow market={market}/></Suspense>
      <Suspense fallback={<HoldersFallback/>}><HoldersRows market={market}/></Suspense>
    </ul>
    <p className="trust-foot">Facts, not advice. Launcher figures count trades on repo.ing only.</p>
  </section>
}
