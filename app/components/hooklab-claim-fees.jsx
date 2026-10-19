'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Coins } from 'lucide-react'
import { useWallet } from './wallet'
import { useHookWalletSession } from './hooklab-wallet-signin'
import { sol } from '../lib/hooklab-trade-math.mjs'
import { expectOperation, isFinal, runOperation } from '../lib/hooklab-trade-runner.mjs'

const endpoint = '/api/hook-lab/native-claim'
// Fees arrive a trade at a time, so small amounts show every lamport.
export const claimText = lamports => sol(lamports, BigInt(lamports) < 1_000_000n ? 9 : 6)
const STEP_TEXT = { review: 'Preparing…', sign: 'Approve in your wallet', send: 'Sending…', confirm: 'Confirming on Solana…' }
// An unfinished claim survives a reload so this card can finish confirming it instead of starting another.
const PENDING = 'repo.ing.hooks.claim.pending.v1'
const pendingFor = (wallet, mint) => { try { return (JSON.parse(localStorage.getItem(PENDING)) ?? []).find(x => x.wallet === wallet && x.mint === mint) ?? null } catch { return null } }
const remember = entry => { try { localStorage.setItem(PENDING, JSON.stringify([...(JSON.parse(localStorage.getItem(PENDING)) ?? []).filter(x => x.signingId !== entry.signingId), entry].slice(-10))) } catch {} }
const forget = signingId => { try { localStorage.setItem(PENDING, JSON.stringify((JSON.parse(localStorage.getItem(PENDING)) ?? []).filter(x => x.signingId !== signingId))) } catch {} }

export async function callClaim(body) {
  const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => { throw Error('The connection dropped. If you signed the claim it is saved; this card checks it again.') })
  if (value.status === 'blocked') throw Object.assign(Error(value.blockers?.[0]?.message || 'Claims are unavailable right now.'), { code: value.blockers?.[0]?.code })
  if (response.status === 401) throw Object.assign(Error('Sign in with your wallet again.'), { code: 'SIGNED_OUT' })
  if (!response.ok || value.status !== 'available') throw Error(value.error || 'Claims are unavailable right now.')
  return value
}

// What the creator of a native-SOL coin sees: the SOL its trades paid them, and one button to take it. Nothing for
// anyone else, and nothing for a coin whose fees are not paid in SOL. Pure: the container below owns the reads and the claim.
export function HookClaimFeesView({ claim, wallet, symbol, signedIn, busy = false, step = '', done = '', error = '', onClaim }) {
  if (!claim?.native || !wallet || claim.creator !== wallet) return null
  // amount: what trades paid; receive: what reaches the wallet after the network fee (0 until a claim is worth its fee).
  const amount = BigInt(claim.claimableLamports ?? '0'), receive = claim.ready ? BigInt(claim.receiveLamports) : 0n, coin = symbol ? `$${symbol}` : 'your coin'
  const line = receive > 0n ? <>Trades of {coin} have paid you {claimText(amount)}. After the network fee, {claimText(receive)} comes to this wallet.</>
    : amount > 0n ? <>Trades of {coin} have paid you {claimText(amount)} so far. You can claim it once it is worth more than the network fee.</>
      : <>No fees to claim yet. Every buy and sell of {coin} adds to them.</>
  return <section className="hooks-claim" aria-labelledby="hooks-claim-title" aria-live="polite">
    <div>
      <Coins size={20} aria-hidden="true"/>
      <div><strong id="hooks-claim-title">Your creator fees</strong><span>{line}</span></div>
      {receive > 0n && signedIn && <button type="button" className="button primary" disabled={busy} onClick={onClaim}>{busy ? step || 'Working…' : `Claim ${claimText(receive)}`}</button>}
    </div>
    {receive > 0n && !signedIn && <p className="hooks-claim-note">Sign in with this wallet to claim it.</p>}
    {done && <p role="status" className="hooks-trade-result">{done}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}

export function HookClaimFees({ mint, symbol, genesisHash }) {
  const { wallet, provider } = useWallet()
  const session = useHookWalletSession(genesisHash)
  const [claim, setClaim] = useState(null), [busy, setBusy] = useState(false), [step, setStep] = useState(''), [done, setDone] = useState(''), [error, setError] = useState('')
  const running = useRef(false)
  const load = useCallback(async () => { try { setClaim((await callClaim({ action: 'status', mint })).claim ?? null) } catch { setClaim(null) } }, [mint])
  useEffect(() => { load() }, [load])

  const finish = useCallback(async (create, signingId) => {
    if (running.current) return
    running.current = true; setBusy(true); setError(''); setDone('')
    try {
      remember({ wallet, mint, signingId, createdAt: Date.now() })
      const op = await runOperation({ call: callClaim, create, signingId, wallet, genesisHash, signTransaction: tx => provider().signTransaction(tx), onStatus: s => setStep(STEP_TEXT[s] ?? '') })
      if (isFinal(op.status)) forget(signingId)
      if (op.status !== 'finalized-success') throw Error(op.status === 'finalized-failure' ? 'The claim failed on Solana. Only its network fee was charged.' : 'Still confirming. This card keeps your claim and checks it again.')
      // What reached the wallet: the claimed lamports less the claim's own network fee.
      const delivered = op.settlement?.quote?.delivered, fee = op.settlement?.feeLamports
      setDone(delivered && fee ? `Claimed: ${claimText(BigInt(delivered) - BigInt(fee))} is in your wallet.` : 'Claimed. The SOL is in your wallet.')
    } catch (e) { setError(e.message || 'Claim failed. Nothing more was signed.') }
    finally { running.current = false; setBusy(false); setStep(''); load() }
  }, [wallet, mint, genesisHash, provider, load])

  // Finish confirming a claim a reload interrupted. Never re-signs: an unsigned review is dropped, a signed one is only
  // sent if it was not yet, and then reconciled.
  useEffect(() => {
    const pending = wallet && session.signedIn && pendingFor(wallet, mint)
    if (!pending) return
    const ids = { signingId: pending.signingId, wallet, genesisHash }
    callClaim({ action: 'get', signingId: pending.signingId }).then(value => {
      const op = expectOperation(value, ids)
      if (op.status === 'reviewed' || isFinal(op.status)) return forget(pending.signingId)
      return runOperation({ call: callClaim, create: { action: 'get' }, ...ids, signTransaction: async () => { throw Error('unsigned') } })
        .then(final => { if (isFinal(final.status)) forget(pending.signingId) })
    }).catch(() => {}).finally(load)
  }, [wallet, mint, genesisHash, session.signedIn, load])

  return <HookClaimFeesView claim={claim} wallet={wallet} symbol={symbol} signedIn={session.signedIn} busy={busy} step={step} done={done} error={error}
    onClaim={() => finish({ action: 'claim', mint }, crypto.randomUUID())}/>
}
