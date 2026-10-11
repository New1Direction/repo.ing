'use client'
import { useEffect, useRef, useState } from 'react'
import { useWallet } from '../wallet'
import { formatUnits } from '../../lib/format.mjs'
import { clearBackedRepo, storedBackedRepo } from '../../lib/backed-repo.mjs'
import { PACK_NAMES, TIERS, money, percent, rarityOf, times } from './packs-model.mjs'

// AI credit packs on /credits (src/credits-packs.mjs, app/api/credits/packs/route.js). The shelf and the stage are drawn
// in the browser (pack-shelf.mjs, pack-stage.mjs); the server gets the quote, prepares the transfer and broadcasts the
// signed bytes, and the credit service credits the payment and spins once. The stage only shows that saved spin.
const OPEN = ['requested', 'quoted', 'prepared', 'submitted']
const TERMS = ['Each paid pack spins once, on the server, when the payment is final. You get at least the pack in paid credits, never less than you pay; a win adds bonus credits, spent after paid credits.',
  'Credits buy AI model use in your coding tools. They never turn into cash and do not expire.',
  'A payment that does not match the quote waits for a review by repo.ing: a refund, or credits with no spin.']
const sol = lamports => formatUnits(String(lamports))
const left = (expiresAt, now) => {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const packOf = purchase => Number(purchase.packMicro) / 1_000_000
const explorer = (signature, network) => `https://explorer.solana.com/tx/${signature}${network === 'devnet' ? '?cluster=devnet' : ''}`

// A pack's builder share in micro-USD (src/builder-pack-shares.mjs, shareMicro): rounded down.
const shareOf = (pack, shareBps) => BigInt(pack) * 1_000_000n * BigInt(shareBps) / 10_000n

// builderShares: { shareBps } while packs may back a repository (src/builder-pack-shares.mjs), else null.
export function CreditPacks({ signedIn, login, network = 'mainnet', fonts, builderShares = null }) {
  const { wallet, provider, connect } = useWallet()
  const walletRef = useRef(wallet); walletRef.current = wallet
  const shelfRef = useRef(null), stageRef = useRef(null), openRef = useRef(null), lastStatus = useRef(null)
  const [webgl, setWebgl] = useState(true)
  const [selected, setSelected] = useState(25)
  const [data, setData] = useState({ odds: null, offer: null, purchase: null, needsSignIn: false }), [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [now, setNow] = useState(Date.now())
  // The repository this buyer picked on a token page (app/lib/backed-repo.mjs): { repoId, fullName, eligible, reason }, or null;
  // unchecked: a pick is stored but its check did not answer.
  const [backed, setBacked] = useState(null), [unchecked, setUnchecked] = useState(false)
  const purchase = data.purchase, open = purchase && OPEN.includes(purchase.status)
  const sales = data.offer?.sales, room = data.offer ? BigInt(data.offer.roomMicro) : null
  // Nothing is sold while sales are off or paused, or while the credit service's odds cannot be read.
  const closed = sales === 'off' || sales === 'paused' || (signedIn && loaded && !data.odds)
  const waiting = purchase?.status === 'submitted'
  const tooBig = room !== null && BigInt(selected) * 1_000_000n > room

  async function call(method, body) {
    const response = await fetch('/api/credits/packs', method === 'GET' ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw Object.assign(Error(result.error || 'AI credit packs are not available right now.'), { status: response.status })
    return result
  }
  const setPurchase = next => setData(current => ({ ...current, purchase: next }))
  async function refresh() {
    const result = await call('GET')
    setData({ odds: result.odds ?? null, offer: result.offer ?? null, purchase: result.purchase ?? null, needsSignIn: Boolean(result.needsSignIn) })
    setLoaded(true)
    return result.purchase ?? null
  }

  // The shelf and the stage: browser-only modules, loaded after the first paint.
  useEffect(() => {
    let shelf = null, stage = null, live = true
    ;(async () => {
      const [art, shelves, stages] = await Promise.all([import('./pack-art.mjs'), import('./pack-shelf.mjs'), import('./pack-stage.mjs')])
      if (!live) return
      art.setFonts(fonts ?? {})
      shelf = shelves.createShelf([...shelfRef.current.querySelectorAll('.pack[data-price]')])
      setWebgl(Boolean(shelf))
      stage = stages.createPackStage({ onDone: () => refresh().catch(() => {}), onAgain: () => openRef.current?.(), onHide: () => {} })
      stageRef.current = stage
    })()
    return () => { live = false; shelf?.destroy(); stage?.destroy(); stageRef.current = null }
  }, [])
  useEffect(() => {
    let active = true
    refresh().catch(e => { if (active) { setError(e.message); setLoaded(true) } })
    return () => { active = false }
  }, [])
  // Any answer but a good one (rate limited, switched off, unreachable) leaves the pick unchecked: a note says so, and the pack
  // backs no repository.
  const backing = Boolean(builderShares) && signedIn
  useEffect(() => {
    if (!backing) return
    let live = true, repo = null
    try { repo = storedBackedRepo(window.localStorage) } catch { /* Storage is optional. */ }
    if (!repo) return
    fetch(`/api/credits/shares/${repo}`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(value => {
        if (!live) return
        if (value?.repoId === repo && typeof value.eligible === 'boolean') setBacked(value)
        else setUnchecked(true)
      })
      .catch(() => { if (live) setUnchecked(true) })
    return () => { live = false }
  }, [backing])
  function removeBacked() {
    try { clearBackedRepo(window.localStorage) } catch { /* Storage is optional. */ }
    setBacked(null); setUnchecked(false)
  }
  // While a payment finalizes: ask every 4 seconds (not without a credit service session: that needs a click to sign in
  // again); once credited, the stage (if open) tears the pack and shows the spin.
  const polling = waiting && !data.needsSignIn
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      if (polling) refresh().catch(() => {})
    }, polling ? 4000 : 1000)
    return () => clearInterval(timer)
  }, [purchase?.id, polling])
  useEffect(() => {
    const before = lastStatus.current, stage = stageRef.current
    lastStatus.current = purchase?.status ?? null
    if (!purchase || purchase.status === 'submitted') return
    // A sent payment that failed on chain, or can no longer land: the quote reopened. Nothing was paid.
    if (before === 'submitted' && ['quoted', 'prepared'].includes(purchase.status)) {
      stage?.close()
      setError('Your payment did not go through. Nothing was paid; approve again while the quote lasts.')
      return
    }
    if (!stage?.isOpen) return
    if (purchase.status === 'credited' && purchase.spin) stage.reveal(purchase.spin, purchase.packMicro)
    else if (!OPEN.includes(purchase.status)) stage.close()
  }, [purchase?.id, purchase?.status])

  // One click: the quote, then one wallet approval; the stage shows the pack meanwhile.
  async function openPack(pack = selected) {
    setError('')
    const stage = stageRef.current
    stage?.open(pack, `Opening your ${PACK_NAMES[pack]} pack. Getting a quote…`)
    setBusy('Signing you in to AI credits and getting a quote…')
    let quoted
    try { quoted = (await call('POST', { action: 'quote', packMicro: String(pack * 1_000_000), ...(backed?.eligible ? { builderRepoId: backed.repoId } : {}) })).purchase; setPurchase(quoted) }
    catch (e) { stage?.close(); setError(e.message); setBusy(''); await refresh().catch(() => {}); return }
    // A request that never got its answer is asked again for its own pack: show that pack.
    if (packOf(quoted) !== pack && stage) { stage.close(); stage.open(packOf(quoted), `Your ${PACK_NAMES[packOf(quoted)]} pack, asked for earlier.`) }
    await approve(quoted)
  }
  openRef.current = openPack
  async function approve(current = purchase) {
    setError('')
    let payer = walletRef.current
    try { payer = payer || await connect() } catch (e) { stageRef.current?.close(); setError(e.message || 'Connect a wallet to pay.'); setBusy(''); return }
    if (!payer) { stageRef.current?.close(); setError('Connect a wallet to pay.'); setBusy(''); return }
    const stage = stageRef.current
    if (stage && !stage.isOpen) stage.open(packOf(current), 'Preparing the payment…')
    setBusy('Preparing the payment…'); stage?.status('Preparing the payment…')
    let prepared, signed
    try {
      prepared = await call('POST', { action: 'prepare', id: current.id, payer })
      setPurchase(prepared.purchase)
      const text = `Approve ${sol(prepared.purchase.lamports)} SOL in your wallet: ${money(prepared.purchase.packMicro)} at ${money(prepared.purchase.priceMicroPerSol)} a SOL…`
      setBusy(text); stage?.status(text)
      const wallet = provider()
      if (wallet?.publicKey?.toBase58() !== payer) throw Error('Your wallet changed. Try again.')
      const { Transaction } = await import('@solana/web3.js')
      signed = await wallet.signTransaction(Transaction.from(Uint8Array.from(atob(prepared.transaction), c => c.charCodeAt(0))))
      if (walletRef.current !== payer) throw Error('Your wallet changed. Nothing was sent.')
    } catch (e) {
      stage?.close()
      setError(prepared ? 'The payment was not approved. Nothing was sent; your SOL stays in your wallet.' : e.message)
      setBusy(''); return
    }
    try {
      setBusy('Sending your payment…'); stage?.status('Sending your payment…')
      const bytes = signed.serialize()
      setPurchase((await call('POST', { action: 'submit', id: current.id, signedTransaction: btoa(String.fromCharCode(...bytes)) })).purchase)
      stage?.status('Payment sent. Waiting for it to finalize on Solana (about half a minute)…', { canHide: true })
    } catch (e) { stage?.close(); setError(e.message); await refresh().catch(() => {}) }
    finally { setBusy('') }
  }
  async function cancel() {
    setError(''); setBusy('Cancelling…')
    try { setPurchase((await call('POST', { action: 'cancel', id: purchase.id })).purchase) } catch (e) { setError(e.message) } finally { setBusy('') }
  }
  // "Refresh status" is a click: when the credit service session is gone, it signs in again (a live GitHub admin check).
  async function check() {
    setError('')
    if (!(data.needsSignIn && open && purchase.status !== 'requested')) return refresh().catch(e => setError(e.message))
    setBusy('Checking your payment…')
    try { setPurchase((await call('POST', { action: 'check', id: purchase.id })).purchase); setData(current => ({ ...current, needsSignIn: false })) }
    catch (e) { setError(e.message) } finally { setBusy('') }
  }
  function show() {
    const stage = stageRef.current
    if (!stage || !purchase?.spin) return
    stage.open(packOf(purchase), 'Your pack is ready.')
    stage.reveal(purchase.spin, purchase.packMicro)
  }

  const odds = data.odds ?? null
  const terms = data.offer?.terms?.length ? data.offer.terms : TERMS
  const devnet = network === 'devnet' && <p className="packs-note">Devnet test: set your wallet to Devnet before you approve.</p>
  const last = purchase?.status === 'credited' && purchase.spin && <div className="packs-last">
    <span className={`packs-gem is-${rarityOf(purchase.spin.multiplierBps).key}`} aria-hidden="true"/>
    <span>Last pack: <strong>{rarityOf(purchase.spin.multiplierBps).name} {times(purchase.spin.multiplierBps)}</strong> · {money(BigInt(purchase.spin.paidMicro) + BigInt(purchase.spin.bonusMicro))} of AI credits</span>
    <button type="button" className="claim-text-button" onClick={show}>Open it again</button>
  </div>
  const share = purchase?.status === 'credited' && purchase.spin && purchase.builder && <p className="packs-note">You backed {backed?.repoId === purchase.builder.repoId ? backed.fullName : 'a repository'}: {money(purchase.builder.shareMicro)} in AI credits to its builders.</p>

  return <section className={`credit-packs${webgl ? '' : ' no-webgl'}`} aria-busy={Boolean(busy)}>
    <div className="packs-shelf" ref={shelfRef} role="group" aria-label="Choose a pack">
      {TIERS.map(price => <button key={price} type="button" className="pack" data-price={price} aria-pressed={selected === price} disabled={Boolean(busy) || Boolean(open)}
        onClick={() => setSelected(price)}>
        <span className="pack-art"><canvas className="pack-canvas" aria-hidden="true"/><span className="pack-print" aria-hidden="true"><b>{PACK_NAMES[price]}</b><i>${price}</i></span></span>
        <span className="pack-meta"><b>{PACK_NAMES[price]}</b><span>${price} · at least ${price} in credits</span></span>
      </button>)}
    </div>
    <div className="packs-opener">
      <div className="packs-odds">
        <h2>Odds for every pack</h2>
        {odds ? <ul className="packs-odds-list">{odds.map(o => {
          const rarity = rarityOf(o.multiplier_bps)
          return <li key={o.multiplier_bps} className={`is-${rarity.key}`}><span className="packs-gem" aria-hidden="true"/><span>{rarity.name}</span>
            <span className="packs-mult">{times(o.multiplier_bps)}</span><b>{percent(o.probability_bps)}</b></li>
        })}</ul> : <p className="packs-note">The odds could not be read. Try again in a minute.</p>}
        <ul className="packs-terms">{terms.map(line => <li key={line}>{line}</li>)}</ul>
      </div>
      <div className="packs-panel">
        {!signedIn ? <>
          <h2>Sign in to open packs</h2>
          <p>Anyone with a GitHub account can open packs: your credits belong to your GitHub account. You pay in SOL from your own wallet, at the price of the moment.</p>
          <a className="button primary" href="/api/github/start?mode=credits">Sign in with GitHub</a>
          <p className="packs-note">Read-only. It only tells repo.ing who you are.</p>
        </> : !loaded ? <p role="status">Checking your packs…</p> : open ? <>
          <h2>Your {PACK_NAMES[packOf(purchase)]} pack</h2>
          {purchase.status === 'requested' ? <>
            <p>Your last request for this pack did not finish. Nothing was paid. Ask again (the same quote comes back if it was made), or cancel.</p>
            <div className="packs-actions"><button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => openPack(packOf(purchase))}>Ask again</button>
              <button type="button" className="button outline" disabled={Boolean(busy)} onClick={cancel}>Cancel</button></div>
          </> : purchase.status === 'submitted' ? <>
            <p role="status">{data.needsSignIn ? `Payment of ${sol(purchase.lamports)} SOL sent. Check it to open your pack: this signs you in to AI credits again.`
              : `Payment of ${sol(purchase.lamports)} SOL sent. Waiting for it to finalize on Solana; your pack opens right after.`}</p>
            {data.needsSignIn && <button type="button" className="button primary" disabled={Boolean(busy)} onClick={check}>Check my payment</button>}
            {purchase.signature && <a className="packs-link" href={explorer(purchase.signature, network)} target="_blank" rel="noopener noreferrer">View payment ↗</a>}
          </> : Date.parse(purchase.expiresAt) <= now ? <p role="status">This quote expired. Nothing was charged.</p> : <>
            <dl className="packs-quote">
              <div><dt>You pay</dt><dd>{sol(purchase.lamports)} SOL</dd></div>
              <div><dt>You get</dt><dd>at least {money(purchase.packMicro)} of AI credits</dd></div>
              {purchase.builder && <div><dt>Backs</dt><dd>{backed?.repoId === purchase.builder.repoId ? backed.fullName : 'a repository'} · {money(purchase.builder.shareMicro)} in AI credits to its builders</dd></div>}
              <div><dt>Quote expires in</dt><dd>{left(purchase.expiresAt, now)}</dd></div>
            </dl>
            {devnet}
            <div className="packs-actions"><button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => approve()}>{wallet ? 'Approve in wallet' : 'Connect wallet and approve'}</button>
              <button type="button" className="button outline" disabled={Boolean(busy)} onClick={cancel}>Cancel</button></div>
          </>}
        </> : <>
          <h2>Open the {PACK_NAMES[selected]} pack</h2>
          {purchase?.status === 'review' && <p role="status">Your last payment needs a review by repo.ing (wrong amount, late, or paid twice). Nothing is lost: you get a refund, or credits.</p>}
          {purchase?.status === 'expired' && <p role="status">The last quote expired. Nothing was charged.</p>}
          {purchase?.status === 'cancelled' && <p role="status">Cancelled. Nothing was charged. A new pack is possible when the old quote ends (at most 20 minutes).</p>}
          {last}{share}
          <p>Signed in as <strong>@{login}</strong>. One approval in your wallet pays the ${selected} pack in SOL; the pack opens when the payment is final.</p>
          {room !== null && <p className="packs-note">You can open {money(room)} more in packs today ($250 a day).</p>}
          {devnet}
          {backed?.eligible ? <p className="packs-backing">Backing <strong>{backed.fullName}</strong> · {money(shareOf(selected, builderShares.shareBps))} of this pack goes to its builders as AI credits. <button type="button" className="claim-text-button" onClick={removeBacked}>Remove</button></p>
            : backed ? <p className="packs-note">{backed.reason ?? 'This repository cannot be backed.'} This pack backs no repository. <button type="button" className="claim-text-button" onClick={removeBacked}>Remove</button></p>
              : unchecked && <p className="packs-note">We could not check the repository you picked. This pack backs no repository. Reload to try again. <button type="button" className="claim-text-button" onClick={removeBacked}>Remove</button></p>}
          <div className="packs-actions"><button type="button" className="button primary" disabled={Boolean(busy) || closed || tooBig} onClick={() => openPack()}>
            {closed ? 'Pack sales are paused' : `Open the ${PACK_NAMES[selected]} pack · $${selected}`}</button></div>
          {signedIn && loaded && !data.odds && <p className="packs-note">The odds from the AI credits service could not be read, so packs are not sold right now.</p>}
          {tooBig && <p className="packs-note">That is more than you can open today. Choose a smaller pack.</p>}
        </>}
        {busy && <p className="claim-progress" role="status"><span className="claim-spinner" aria-hidden="true"/>{busy}</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {signedIn && loaded && !busy && <button type="button" className="claim-text-button" onClick={check}>Refresh status</button>}
      </div>
    </div>
  </section>
}
