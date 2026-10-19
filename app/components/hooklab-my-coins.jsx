'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { useWallet } from './wallet'
import { HookWalletSignIn, useHookWalletSession } from './hooklab-wallet-signin'
import { HookCoinPreview } from './hooklab-coin-form'
import { sol } from '../lib/hooklab-trade-math.mjs'
import { forgetOperation, isFinal, rememberOperation, runOperation } from '../lib/hooklab-trade-runner.mjs'
import { coinImageUrl } from '../../src/hooklab-coin-profile.mjs'
import { HookClaimFees } from './hooklab-claim-fees'

const REQUEST_TEXT = { queued: 'Waiting for approval', invited: 'Invited: finish your launch', launching: 'Launching', launched: 'Live',
  declined: 'Not approved', cancelled: 'Cancelled', 'invite-expired': 'Invite ended' }

// The signed-in creator's Hook Lab SOL (with withdraw) and their launch request or coin. nativeClaims
// (HOOK_NATIVE_LAUNCHES_ENABLED): a launched native-SOL coin also offers its creator fees to claim.
export function HookMyCoins({ genesisHash, nativeClaims = false }) {
  const { wallet, provider } = useWallet()
  const session = useHookWalletSession(genesisHash)
  const [balances, setBalances] = useState(null), [request, setRequest] = useState(null)
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState(''), [done, setDone] = useState('')
  const load = useCallback(async () => {
    if (!wallet) return
    try {
      const response = await fetch(`/api/hook-lab/wallet/${wallet}`, { cache: 'no-store' }); const value = await response.json()
      if (response.ok) setBalances(value)
      if (session.signedIn) {
        const mine = await (await fetch('/api/hook-lab/launch-requests', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get' }) })).json()
        setRequest(mine.request ?? null)
      }
    } catch { setError('Could not load your balances. Try again in a moment.') }
  }, [wallet, session.signedIn])
  useEffect(() => { load() }, [load])

  async function withdraw() {
    const amount = BigInt(balances?.wallet?.bridgedSol ?? 0)
    if (busy || amount <= 0n) return
    setBusy(true); setError(''); setDone('')
    const signingId = crypto.randomUUID()
    try {
      rememberOperation(localStorage, { wallet, signingId, kind: 'withdraw', createdAt: Date.now() })
      const op = await runOperation({ create: { action: 'withdraw', request: { lamports: String(amount) } }, signingId, wallet, genesisHash,
        signTransaction: tx => provider().signTransaction(tx), onStatus: s => setStatus({ review: 'Preparing…', sign: 'Approve in your wallet', send: 'Sending…', confirm: 'Confirming on Solana…' }[s]) })
      if (isFinal(op.status)) forgetOperation(localStorage, signingId)
      if (op.status !== 'finalized-success') throw Error(op.status === 'finalized-failure' ? 'The withdraw failed on Solana. Only its network fee was charged.' : 'Still confirming. This page keeps your transaction and checks it again.')
      setDone(`${sol(amount, 6)} is back in your wallet.`)
    } catch (e) { setError(e.message || 'Withdraw failed. Nothing more was signed.') }
    finally { setBusy(false); setStatus(''); load() }
  }

  if (!session.signedIn) return <HookWalletSignIn genesisHash={genesisHash} session={session} title="Sign in to see your coins">Sign in with the wallet you launch and trade with. It’s free and sends no transaction.</HookWalletSignIn>
  const bridged = BigInt(balances?.wallet?.bridgedSol ?? 0)
  return <div className="hooks-mine">
    <section className="hooks-card" aria-labelledby="hooks-mine-sol"><h2 id="hooks-mine-sol">Your SOL</h2>
      <dl className="hooks-coin-stats">
        <div><dt>Wallet</dt><dd>{balances ? sol(balances.wallet.lamports) : '…'}</dd></div>
        <div><dt>In Hook Lab</dt><dd>{balances ? sol(bridged, 6) : '…'}</dd></div>
      </dl>
      <p>SOL in Hook Lab is what you trade Hooks coins with. Selling sends it back automatically; anything left over can come back to your wallet here.</p>
      {bridged > 0n && <button type="button" className="button primary" disabled={busy || !balances?.funding} onClick={withdraw}>{busy ? status || 'Working…' : `Withdraw ${sol(bridged, 6)}`}</button>}
      {done && <p role="status" className="hooks-trade-result">{done}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </section>
    <section className="hooks-card" aria-labelledby="hooks-mine-launch"><h2 id="hooks-mine-launch">Your launch</h2>
      {request ? <>
        <HookCoinPreview image={request.profile ? coinImageUrl('', request.id, 128) : null} name={request.name} symbol={request.symbol} capBps={request.capBps} creatorFeeBps={request.creatorFeeBps} profile={request.profile}
          note={REQUEST_TEXT[request.status] ?? request.status}/>
        {nativeClaims && request.mint && request.status === 'launched' && <HookClaimFees mint={request.mint} symbol={request.symbol} genesisHash={genesisHash}/>}
        <div className="launch-review-actions">{request.mint ? <Link className="button primary" href={`/hooks/token/${request.mint}`}>Open {`$${request.symbol}`} <ArrowRight size={16} aria-hidden="true"/></Link>
          : <Link className="button" href="/hooks/launch-review">Open your launch</Link>}</div>
      </> : <><p>You haven’t launched a coin with this wallet yet.</p><Link className="button primary" href="/hooks/launch-review">Launch a coin</Link></>}
    </section>
  </div>
}
