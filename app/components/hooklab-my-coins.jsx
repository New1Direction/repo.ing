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

const REQUEST_TEXT = { queued: 'Not launched yet', invited: 'Not launched yet', launching: 'Launching', launched: 'Live',
  declined: 'Not launched', cancelled: 'Cancelled', 'invite-expired': 'Not launched' }

// The signed-in creator's launch or coin. nativeClaims (HOOK_NATIVE_LAUNCHES_ENABLED): a launched native-SOL coin also
// offers its creator fees to claim. Coins on our own stack trade straight from the wallet's SOL, so there is nothing to
// move in or out; only a wallet that still holds SOL in Hook Lab from an earlier (bridged) coin sees how to withdraw it.
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
  return <HookMyCoinsBody balances={balances} request={request} busy={busy} status={status} done={done} error={error} onWithdraw={withdraw}
    nativeClaims={nativeClaims} genesisHash={genesisHash}/>
}

// What a signed-in creator sees: Withdraw only for a wallet still holding SOL in Hook Lab from an earlier coin, then
// their launch or coin. balances: the wallet API's { wallet: { lamports, bridgedSol }, funding }.
export function HookMyCoinsBody({ balances, request, busy = false, status = '', done = '', error = '', onWithdraw, nativeClaims = false, genesisHash }) {
  const bridged = BigInt(balances?.wallet?.bridgedSol ?? 0)
  return <div className="hooks-mine">
    {(bridged > 0n || done) && <section className="hooks-card" aria-labelledby="hooks-mine-sol"><h2 id="hooks-mine-sol">Withdraw your Hook Lab SOL</h2>
      <p>This wallet still has {sol(bridged, 6)} in Hook Lab from an earlier coin. Send it back to your wallet.</p>
      {bridged > 0n && <button type="button" className="button primary" disabled={busy || !balances?.funding} onClick={onWithdraw}>{busy ? status || 'Working…' : `Withdraw ${sol(bridged, 6)}`}</button>}
      {done && <p role="status" className="hooks-trade-result">{done}</p>}
    </section>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <section className="hooks-card" aria-labelledby="hooks-mine-launch"><h2 id="hooks-mine-launch">Your launch</h2>
      {request ? <>
        <HookCoinPreview image={request.profile ? coinImageUrl('', request.id, 128) : null} name={request.name} symbol={request.symbol} capBps={request.capBps} creatorFeeBps={request.creatorFeeBps} profile={request.profile}
          note={REQUEST_TEXT[request.status] ?? request.status}/>
        {nativeClaims && request.mint && request.status === 'launched' && <HookClaimFees mint={request.mint} symbol={request.symbol} genesisHash={genesisHash}/>}
        <div className="launch-review-actions">{request.mint ? <Link className="button primary" href={`/hooks/token/${request.mint}`}>Open {`$${request.symbol}`} <ArrowRight size={16} aria-hidden="true"/></Link>
          : <Link className="button" href="/hooks/launch-review">{['queued', 'invited', 'launching'].includes(request.status) ? 'Finish your launch' : 'Launch a coin'}</Link>}</div>
      </> : <><p>You haven’t launched a coin with this wallet yet.</p><Link className="button primary" href="/hooks/launch-review">Launch a coin</Link></>}
    </section>
  </div>
}
