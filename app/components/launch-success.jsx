'use client'
import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { ArrowRight, BookOpen, Boxes, CircleCheck, GitCommitHorizontal } from 'lucide-react'
import { CopyAddress } from './copy-address'
import { ShareMarket } from './share-market'
import { LaunchKit, ModelLaunchKit } from './launch-kit'
import { HF_DISCLAIMER } from '../../src/hf-copy.mjs'
import { modelShareText } from '../lib/hf-model-display.mjs'

// Mounted only after the launch API verifies the canonical on-chain pool. A Hugging Face model market (repo.source
// 'huggingface') names the model and carries the community-launch disclaimer, in its share sheet text too.
export function LaunchSuccess({ repo, launched, symbol, image }) {
  const heading = useRef(null)
  const model = repo.source === 'huggingface'
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  return <section className="launch-panel launch-success">
    <div className="launch-transformation" aria-hidden="true">
      <div className="launch-origin">{model ? <Boxes size={24}/> : <BookOpen size={24}/>}<span>{repo.fullName}</span></div>
      <div className="launch-commit-line"><span/><GitCommitHorizontal size={28}/><span/></div>
      <div className="launch-token-card"><img src={image || `/api/token-image/${launched.mint}`} alt=""/><strong>${symbol}</strong><span><CircleCheck size={14}/>Market live</span></div>
    </div>
    <h2 ref={heading} tabIndex={-1}>{model ? 'Success — model has been tokenized' : 'Success — repo has been tokenized'}</h2>
    <p>{repo.fullName} now has a live market.</p>
    {model && <p className="form-fineprint" role="note">{HF_DISCLAIMER}</p>}
    <Link className="button primary launch-submit" href={`/token/${launched.mint}`}>View market <ArrowRight size={18}/></Link>
    {model ? <ModelLaunchKit path={repo.fullName} mint={launched.mint} symbol={symbol}/>
      : <LaunchKit repoId={repo.repoId} fullName={repo.fullName} mint={launched.mint} symbol={symbol} verified={launched.verified === true}/>}
    <CopyAddress address={launched.mint}/>
    {launched.signature && <a className="launch-receipt" href={`https://solscan.io/tx/${launched.signature}`} target="_blank" rel="noreferrer">View launch transaction ↗</a>}
    <ShareMarket mint={launched.mint} symbol={symbol} fullName={repo.fullName} repoId={repo.repoId} readme={!model}
      shareText={model ? modelShareText(repo) : null}/>
  </section>
}
