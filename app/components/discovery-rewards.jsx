'use client'

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Compass } from 'lucide-react'
import { useWallet } from './wallet'
import { CopyAddress } from './copy-address'
import { formatSolDisplay, formatUnits } from '../lib/format.mjs'
import { walletSignatureBytes } from '../lib/solana-wallet.mjs'

export function DiscoveryRewards({ repoId }) {
  const { wallet, connect, changeWallet, provider } = useWallet()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [stage, setStage] = useState('')
  const [busy, setBusy] = useState(false)
  const [offer, setOffer] = useState(null)
  const working = useRef(false)
  const endpoint = `/api/discovery/${repoId}`
  useEffect(() => { setOffer(null); setError('') }, [wallet, endpoint])
  const request = async body => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Could not process this claim')
    return result
  }
  async function refresh() {
    const response = await fetch(endpoint, { cache: 'no-store' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    setData(result)
    return result
  }
  useEffect(() => {
    let active = true
    let timer
    async function poll() {
      try {
        const response = await fetch(endpoint, { cache: 'no-store' })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error)
        if (!active) return
        setData(result)
        if (result.latestClaim?.status === 'pending' && !working.current) {
          await request({ action: 'check' })
        }
        timer = setTimeout(poll, result.latestClaim?.status === 'pending' ? 3000 : 15000)
      } catch (cause) {
        if (active) { setError(cause.message || 'Could not refresh rewards'); timer = setTimeout(poll, 15000) }
      }
    }
    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [endpoint])

  async function claim(approve = false) {
    if (working.current) return
    working.current = true; setBusy(true); setError('')
    try {
      const address = wallet || await connect()
      if (address !== data.wallet) throw new Error('Switch to the wallet that launched this repository.')
      setStage('Checking your discovery reward…')
      const prepared = approve && offer ? offer : await request({ action: 'prepare', wallet: address })
      if (prepared.status === 'pending') {
        setStage('Payout submitted. Waiting for Solana finality…')
      } else if (!approve) {
        setOffer(prepared)
        setStage('')
      } else {
        // A message signature only: the wallet never signs a transaction. repo.ing builds, pays for and sends the payout.
        setStage('Sign the claim message in your wallet…')
        const signature = walletSignatureBytes(await provider().signMessage(new TextEncoder().encode(prepared.message)))
        const { default: bs58 } = await import('bs58')
        setStage('Sending your reward…')
        await request({ action: 'submit', id: prepared.id, signature: bs58.encode(signature) })
        setOffer(null)
        setStage('Payout submitted. Waiting for Solana finality…')
      }
      await refresh()
    } catch (cause) {
      setError(cause.message || 'Claim was not completed. Check its status before retrying.')
      setOffer(null)
      setStage('')
      await refresh().catch(() => {})
    } finally { working.current = false; setBusy(false) }
  }

  if (data?.enrolled === false) return null
  const pending = data?.latestClaim?.status === 'pending'
  const receipt = data?.latestClaim?.status === 'settled' ? data.latestClaim : null
  // Only a signed payout that failed is shown as a failure; an unsigned confirmation that simply expired is not.
  const failed = data?.latestClaim?.status === 'aborted' && data.latestClaim.signature ? data.latestClaim : null
  const ended = data?.capped || data?.expired || data?.graduated
  const launcher = Boolean(data?.wallet) && wallet === data.wallet
  const claimable = data?.remaining ? BigInt(data.remaining) > 0n : false
  const tooSmall = claimable && BigInt(data.remaining) < BigInt(data.minClaim ?? '0')
  return <section className="inner-card discovery-rewards" aria-labelledby="discovery-heading">
    <div className="card-heading"><h3 id="discovery-heading"><Compass size={19}/> Discovery rewards</h3>
      {data && <span className="small-chip">{data.capped ? `${formatSolDisplay(data.cap)} SOL cap reached` : data.graduated ? 'Graduated' : data.expired ? 'Earning period ended' : data.graduated === null ? 'Checking pool status' : 'Earning'}</span>}</div>
    <p>The wallet that launched this repo earns 50% of repo.ing’s partner trading fees until graduation, 30 days, or {data ? formatSolDisplay(data.cap) : 'its lifetime cap of'}{data ? ' SOL earned' : ' rewards'}—whichever comes first.</p>
    {!data ? <p role="status">Loading discovery rewards…</p> : <>
      <div className="discovery-totals"><div><span>Total earned</span><strong>{formatSolDisplay(data.earned)} SOL</strong></div>
        <div><span>Already paid</span><strong>{formatSolDisplay(data.paid)} SOL</strong></div>
        <div><span>Available to claim</span><strong>{formatSolDisplay(data.remaining)} SOL</strong></div></div>
      <div className="discovery-recipient"><span>Launcher wallet</span><CopyAddress address={data.wallet} label="launcher wallet"/></div>
      <p className="discovery-note">{ended ? 'Earning has ended. Your accrued rewards remain claimable.' : `Earning ends no later than ${new Date(data.expiresAt).toLocaleDateString()}.`} Builder earnings stay separate. You only sign a message to claim; repo.ing pays the network fee.</p>
      {pending || busy ? <div className="claim-progress" role="status"><span className="claim-spinner" aria-hidden="true"/><span>{pending ? 'Payout submitted. Waiting for Solana finality…' : stage}</span></div> :
        !wallet ? <button type="button" className="button outline" onClick={() => connect().catch(cause => setError(cause.message))}>Launched this repo? Connect to claim</button> :
          !launcher ? <p className="discovery-note">Only the launcher wallet above can claim. Launched this repo from another wallet? <button type="button" className="claim-text-button" onClick={() => changeWallet().catch(cause => setError(cause.message))}>Switch wallet</button></p> :
            offer ? <div className="discovery-review" role="status"><strong>Review your claim</strong>
              <p>Reward: {formatUnits(offer.amount)} SOL, sent to your launcher wallet.<br/>Sign a message to confirm — repo.ing sends the reward to your wallet and pays the network fee. Your wallet does not sign a transaction.</p>
              <button type="button" className="button primary" onClick={() => claim(true)}>Sign message to claim</button>
              <button type="button" className="claim-text-button" onClick={() => setOffer(null)}>Cancel</button></div> :
              claimable ? <div className="discovery-cta"><div><strong>You earned {formatSolDisplay(data.earned)} SOL as launcher</strong>
                <span>{formatSolDisplay(data.remaining)} SOL is ready to claim to this wallet.</span></div>
                {tooSmall ? <span className="discovery-note">Reward too small to claim yet. At least {formatSolDisplay(data.minClaim)} SOL must accrue first.</span> :
                  <button type="button" className="button primary" disabled={!data.payoutReady} onClick={() => claim()}>Claim {formatSolDisplay(data.remaining)} SOL</button>}</div> :
                <p className="discovery-note">{BigInt(data.earned) > 0n ? 'All launcher rewards earned so far have been paid to this wallet.' : 'Nothing to claim yet. Rewards appear here as this market trades.'}</p>}
      {!data.payoutReady && <p role="status">Payouts are temporarily unavailable. Your recorded rewards are preserved.</p>}
      {(pending || receipt) && <div className={`discovery-receipt ${receipt ? 'positive' : ''}`} role="status">
        {receipt && <><CheckCircle2 size={19}/><span>{formatSolDisplay(receipt.amount)} SOL discovery reward claimed.</span></>}
        <a href={`https://explorer.solana.com/tx/${data.latestClaim.signature}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>
      </div>}
      {failed && <div className="discovery-receipt inline-error" role="alert"><span>Claim did not complete. Your reward remains available to claim again.</span>
        {failed.signature && <a href={`https://explorer.solana.com/tx/${failed.signature}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>}</div>}
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}
