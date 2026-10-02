'use client'
import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { ArrowRight, BookOpen, CircleCheck, GitCommitHorizontal } from 'lucide-react'
import { CopyAddress } from './copy-address'
import { ShareMarket } from './share-market'
import { LaunchKit } from './launch-kit'

// Mounted only after the launch API verifies the canonical on-chain pool.
export function LaunchSuccess({ repo, launched, symbol, image }) {
  const heading = useRef(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  return <section className="launch-panel launch-success">
    <div className="launch-transformation" aria-hidden="true">
      <div className="launch-origin"><BookOpen size={24}/><span>{repo.fullName}</span></div>
      <div className="launch-commit-line"><span/><GitCommitHorizontal size={28}/><span/></div>
      <div className="launch-token-card"><img src={image || `/api/token-image/${launched.mint}`} alt=""/><strong>${symbol}</strong><span><CircleCheck size={14}/>Market live</span></div>
    </div>
    <h2 ref={heading} tabIndex={-1}>Success — repo has been tokenized</h2>
    <p>{repo.fullName} now has a live market.</p>
    <Link className="button primary launch-submit" href={`/token/${launched.mint}`}>View market <ArrowRight size={18}/></Link>
    <LaunchKit repoId={repo.repoId} fullName={repo.fullName} mint={launched.mint} symbol={symbol} verified={launched.verified === true}/>
    <CopyAddress address={launched.mint}/>
    {launched.signature && <a className="launch-receipt" href={`https://solscan.io/tx/${launched.signature}`} target="_blank" rel="noreferrer">View launch transaction ↗</a>}
    <ShareMarket mint={launched.mint} symbol={symbol} fullName={repo.fullName} repoId={repo.repoId}/>
  </section>
}
