'use client'
import Link from 'next/link'
import { TransactionStatus } from './ui'
import { useBundleAction } from './bundle-raise'
import { formatSolDisplay } from '../lib/format.mjs'
import { PHASE_LABELS, raiseFigures, raisePhase, raisedPercent, sharePercent } from '../lib/bundle-view.mjs'
import '../bundles.css'

// /wallet: the bundles this wallet backs (app/lib/bundle-wallet.mjs), each with its raise, the wallet's deposit and share, and
// its refund (a failed raise) or claim (a launched one). bundles: null when they cannot be read now; absent when it backs none.
export function WalletBundles({ bundles, onChanged }) {
  if (bundles === undefined) return null
  return <section className="wallet-bundles" aria-labelledby="wallet-bundles-title">
    <h2 id="wallet-bundles-title">Bundles you back</h2>
    {bundles === null ? <p role="status" className="state-card">Your bundles are temporarily unavailable.</p>
      : bundles.length ? <div className="wallet-market-list">{bundles.map(bundle => <WalletBundle key={bundle.id} bundle={bundle} onChanged={onChanged}/>)}</div>
        : <p className="muted">This wallet backs no bundle. Bundles you deposit into appear here.</p>}
  </section>
}

function WalletBundle({ bundle, onChanged }) {
  const action = useBundleAction(onChanged)
  const phase = raisePhase(bundle), figures = raiseFigures(bundle), backer = bundle.backer
  const pending = BigInt(backer?.pending ?? '0')
  const share = BigInt(backer?.shares ?? '0') > 0n && backer.shareBps === 0 ? '<0.01%' : sharePercent(backer?.shareBps ?? 0)
  return <article className="inner-card wallet-market wallet-bundle">
    <Link className="wallet-market-title" href={`/bundle/${bundle.id}`}><img src={`/api/repo-logo/${bundle.repoId}?v=3&w=128`} alt="" width={44} height={44} loading="lazy" decoding="async"/>
      <div><strong>${bundle.tokenSymbol}</strong><span>{bundle.fullName}</span></div></Link>
    <div className="wallet-market-values">
      <span>Bundle<strong>{PHASE_LABELS[phase]}</strong><small>{formatSolDisplay(figures.raised)} of {formatSolDisplay(figures.target)} SOL · {raisedPercent(figures.raised, figures.target)}%</small></span>
      <span>You deposited<strong>{formatSolDisplay(backer?.shares)} SOL</strong><small>{share} of the raise</small></span>
      {phase === 'launched' && <span className={pending > 0n ? 'wallet-launcher-claimable' : ''}>Backer fees<strong>{formatSolDisplay(pending)} SOL to claim</strong><small>{formatSolDisplay(backer?.paid)} SOL claimed</small></span>}
    </div>
    <div className="wallet-market-actions">
      <Link className="button outline" href={`/bundle/${bundle.id}`}>Raise page</Link>
      {bundle.marketMint && <Link className="button outline" href={`/token/${bundle.marketMint}#bundle-vault`}>Vault</Link>}
      {phase === 'failed' && <button type="button" className="button primary" disabled={action.busy} onClick={() => action.run(bundle.id, 'refund')}>{action.busy ? action.stage || 'Preparing…' : `Refund ${formatSolDisplay(backer?.shares)} SOL`}</button>}
      {phase === 'launched' && pending > 0n && <button type="button" className="button primary" disabled={action.busy} onClick={() => action.run(bundle.id, 'claim')}>{action.busy ? action.stage || 'Preparing…' : `Claim ${formatSolDisplay(pending)} SOL`}</button>}
    </div>
    <TransactionStatus stage={action.busy ? '' : action.stage} error={action.error}/>
  </article>
}
