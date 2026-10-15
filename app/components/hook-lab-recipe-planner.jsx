'use client'
import { useEffect, useRef, useState } from 'react'
import { useWallet } from './wallet'
import { createHookLabRecipe, importHookLabRecipe, serializeHookLabRecipe, exportHookLabRecipe,
  loadHookLabRecipe, saveHookLabRecipe, migrateDirectPlanV1ToHookLabRecipe, hookLabRecipeSaveSchema } from '../../src/hook-lab-recipe.mjs'
import { createHookLabCustody, unlockHookLabCustody } from '../lib/hooklab-custody.mjs'
import { openHookLabCustodyStore } from '../lib/hooklab-custody-store.mjs'

const initial = () => createHookLabRecipe({ format: 'hook-lab/1', coin: { name: '', ticker: '' }, blocks: [] }, 'plain')
const accountKey = 'repo.ing:hook-lab-account-save:1'
async function api(body) {
  const response = await fetch('/api/hook-lab', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || data.quote?.reason || 'Request unavailable')
  return data
}

export function HookLabRecipePlanner({ legacyPlan, legacyDrafts = [] }) {
  const { wallet } = useWallet()
  const [envelope, setEnvelope] = useState(initial), [ready, setReady] = useState(false)
  const [listing, setListing] = useState({ signedIn: false, drafts: [], events: [] }), [saved, setSaved] = useState(null)
  const [importText, setImportText] = useState('')
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [observation, setObservation] = useState(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [storageError, setStorageError] = useState('')
  const [passphrase, setPassphrase] = useState(''), [repeat, setRepeat] = useState(''), [lossAccepted, setLossAccepted] = useState(false)
  const [identity, setIdentity] = useState(null)
  const [journalIds, setJournalIds] = useState([]), [journalId, setJournalId] = useState('')
  const generation = useRef(0), custody = useRef(null), store = useRef(null), saveId = useRef(null)
  const recipe = envelope.recipe

  function lock() { custody.current?.lock(); custody.current = null; setIdentity(null); setPassphrase(''); setRepeat('') }
  function invalidate() {
    generation.current++
    setObservation(null); setConfirmed(false); setNotice(''); setLossAccepted(false)
    const session = custody.current
    custody.current = null; setIdentity(null)
    if (session) session.checkBinding(null).catch(() => setError('Could not persist invalidation. Custody is locked; do not reuse this attempt.')).finally(() => session.lock())
  }
  useEffect(() => {
    try {
      const draft = loadHookLabRecipe(localStorage) ?? initial()
      const raw = localStorage.getItem(accountKey)
      if (raw) { const { id, revision } = hookLabRecipeSaveSchema.parse({ ...JSON.parse(raw), envelope: draft }); setSaved({ id, revision }); saveId.current = id }
      setEnvelope(draft); setReady(true)
    }
    catch { setStorageError('This device recipe cannot be read. It has not been overwritten. Export/recover it before using a newer client.') }
    api().then(setListing).catch(e => setError(e.message))
    return () => { generation.current++; custody.current?.lock(); store.current?.close() }
  }, [])
  useEffect(() => { invalidate(); setPassphrase(''); setRepeat('') }, [wallet])
  useEffect(() => {
    if (!ready) return
    try { saveHookLabRecipe(localStorage, envelope); setStorageError('') }
    catch { setStorageError('Device save failed. Export the recipe before leaving; no keys are included.') }
  }, [envelope, ready])
  function change(next) { invalidate(); setEnvelope(next); setError('') }
  function newDraft(next) { localStorage.removeItem(accountKey); change(next); setSaved(null); saveId.current = null }
  function setCoin(key, value) { change({ ...envelope, recipe: { ...recipe, coin: { ...recipe.coin, [key]: value } } }) }
  function startPlain() {
    if (!window.confirm('Replace this device recipe with a new plain draft? Export first to retain it. Account drafts and encrypted identities are unchanged.')) return
    newDraft(initial())
  }
  function download(raw = false) {
    const url = URL.createObjectURL(new Blob([raw ? exportHookLabRecipe(envelope) : serializeHookLabRecipe(envelope)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = raw ? 'hook-lab-recipe.json' : 'repo-ing-recipe.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function perform(action) {
    const current = generation.current
    setBusy(true); setError('')
    try {
      saveId.current ??= crypto.randomUUID()
      if (action === 'save') localStorage.setItem(accountKey, JSON.stringify({ id: saved?.id ?? saveId.current, revision: saved?.revision ?? 0 }))
      const result = await api({ action, envelopeText: serializeHookLabRecipe(envelope), ...(action === 'save'
        ? { id: saved?.id ?? saveId.current, revision: saved?.revision ?? 0 } : { confirmedNetwork: confirmed ? 'devnet' : null }) })
      if (current !== generation.current) return
      if (result.observation) { setObservation(result.observation); setNotice('Fresh devnet observation only. No transaction simulation or launch approval.') }
      if (result.draft) {
        setSaved(result.draft)
        localStorage.setItem(accountKey, JSON.stringify({ id: result.draft.id, revision: result.draft.revision }))
        setNotice(`Account recipe saved, revision ${result.draft.revision}.`); setListing(await api())
      }
    } catch (e) { if (current === generation.current) setError(e.message) }
    finally { setBusy(false) }
  }
  async function findJournals() {
    try {
      store.current ??= await openHookLabCustodyStore()
      const ids = await store.current.listIds()
      setJournalIds(ids); setJournalId(ids[0] ?? '')
      if (!ids.length) setNotice('No retained journals on this browser origin. Nothing was created or deleted.')
    } catch (e) { setError(e.message) }
  }
  async function retainIdentity(recovery = false) {
    const context = observation?.bindingContext
    if (!recovery && (!wallet || !context || Date.now() - Date.parse(observation.checkedAt) > 60000 || !lossAccepted)) {
      setError('Connect a wallet, inspect this recipe again, and acknowledge local storage risks.'); return
    }
    if (recovery && (!journalId || !lossAccepted || !window.confirm('Unlock for recovery only? This permanently invalidates this attempt’s transaction reviews. It cannot authorize signing or retries.'))) return
    const current = generation.current, binding = recovery ? null : { schemaVersion: 'hooklab-binding/1', wallet, ...context }
    const id = recovery ? journalId : `${context.recipeDigest.slice(0, 32)}-${wallet.slice(0, 12)}`
    setBusy(true); setError('')
    let opened
    try {
      store.current ??= await openHookLabCustodyStore()
      const existing = await store.current.load(id)
      if (recovery && !existing) throw new Error('Retained journal not found. Nothing was created.')
      if (!existing && passphrase !== repeat) throw new Error('Recovery passphrases do not match.')
      custody.current?.lock(); custody.current = null
      opened = await (existing ? unlockHookLabCustody : createHookLabCustody)({ store: store.current, id, binding, passphrase })
      if (current !== generation.current) { await opened.checkBinding(null); opened.lock(); return }
      custody.current = opened
      setIdentity(opened.publicIdentity())
      setNotice(opened.snapshot().events.some(e => e.type === 'binding-invalidated')
        ? 'Retained identities unlocked for recovery only. This attempt is permanently invalidated.'
        : 'Identities retained locally. Nothing was created on chain; signing remains disabled.')
    } catch (e) { opened?.lock(); setError(e.message) }
    finally { setPassphrase(''); setRepeat(''); setBusy(false) }
  }
  return <section aria-label="Programmable Coin recipe" className="hook-recipe">
    <div className="coin-workspace"><section>
      <h2>Configure your Programmable Coin</h2>
      <p className="coin-note">Hook Lab DEX · experimental devnet beta. Native tokens, not SPL or Token-2022. Drafts never authorize your wallet.</p>
      {(legacyPlan.name || legacyDrafts.length > 0) && <details open><summary>Earlier Programmable drafts are still available</summary>
        <p>Copy a legacy plan explicitly into the complete recipe format. The original device/account plan is never changed.</p>
        {[...(legacyPlan.name ? [{ id: 'device', plan: legacyPlan }] : []), ...legacyDrafts].map(d => <button className="button" key={d.id} disabled={!ready || busy} onClick={() => {
          try { if (window.confirm('Replace the current recipe with a copy of this earlier plan? The original remains stored.')) newDraft(migrateDirectPlanV1ToHookLabRecipe(d.plan)) }
          catch { setError('Earlier plan could not be copied losslessly. It remains unchanged.') }
        }}>Copy {d.plan.name || 'Untitled'} ({d.id === 'device' ? 'device' : 'account'})</button>)}
      </details>}
      <fieldset className="coin-fields" disabled={!ready || busy}><legend className="sr-only">Plain coin fields</legend>
        <p className="coin-note">Plain launch only: no optional hook, rules or creator fee. Richer templates and trading are deferred. Protocol fees still apply.</p>
        <button className="button" onClick={startPlain}>Start new plain draft</button>
        <div className="coin-field-row"><label>Coin name<input value={recipe.coin.name} onChange={e => setCoin('name', e.target.value)}/></label>
          <label>Ticker<input value={recipe.coin.ticker} onChange={e => setCoin('ticker', e.target.value)}/></label></div>
        {recipe.blocks.length > 0 && <p role="alert" className="coin-error">This stored recipe contains rules outside the plain-only beta. Its rules are preserved, not applied or silently removed. Export it before explicitly starting a new plain draft.</p>}
      </fieldset>
      <details><summary>Import, export or migrate without losing rules</summary>
        <p>Export the full envelope for a repo.ing backup, or raw hook-lab/1 JSON for SDK review. Neither contains keys. Unknown fields stay intact but cannot approve an unsupported intent. Never paste keys, seed phrases or confidential data.</p>
        <div className="coin-actions"><button className="button" onClick={() => download()}>Export full recipe</button><button className="button" onClick={() => download(true)}>Export raw SDK recipe</button></div>
        <label className="coin-import">Recipe JSON<textarea value={importText} maxLength={65536} onChange={e => setImportText(e.target.value)}/></label>
        <button className="button" disabled={!ready || busy} onClick={() => { try { const next = importHookLabRecipe(importText); if (window.confirm('Replace the device recipe with this import?')) { newDraft(next); setImportText('') } } catch { setError('Import refused: unsupported version, duplicate fields, oversized or invalid JSON. Current recipe is unchanged.') } }}>Import recipe</button>
        <button className="button" disabled={!ready || busy} onClick={() => { try { if (window.confirm('Copy the legacy plan into this recipe? The original plan will be retained.')) newDraft(migrateDirectPlanV1ToHookLabRecipe(legacyPlan)) } catch { setError('Legacy plan cannot be converted losslessly.') } }}>Copy legacy Programmable draft</button>
        <pre>{JSON.stringify(envelope, null, 2)}</pre>
      </details>
    </section><aside className="coin-review">
      <h2>Quote & simulate</h2>
      <p className="coin-note">Read-only inspection is available. A launch quote and transaction simulation are not: the adopted arithmetic model covers hypothetical swaps only, not launch fees, nested pool fees, rent or bridge funding.</p>
      <dl><div><dt>Network</dt><dd>Solana devnet only</dd></div><div><dt>Quote asset</dt><dd>Native bridged SOL</dd></div><div><dt>LP custody</dt><dd>Launch PDA · permanently held</dd></div><div><dt>Total wallet debit</dt><dd>Unknown · not zero</dd></div><div><dt>Enforceable fee cap</dt><dd>Unavailable</dd></div></dl>
      <p className="coin-note">Protocol fees and the protocol-wide sniper fee still apply. Virtual reserves are not deposited SOL. Program upgrade/admin authority remains a custody risk.</p>
      <label className="coin-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)}/><span>I confirm devnet for public read-only inspection. No spending, simulation or launch is authorized.</span></label>
      <button className="button primary" disabled={!ready || busy || !confirmed} onClick={() => perform('inspect')}>Inspect complete recipe on devnet</button>
      <button className="button" disabled>Quote / simulate — unavailable</button><button className="button" disabled>Review & sign — unavailable</button>
      <p className="coin-note">Verification not started: no transaction submitted. All six gates remain: custody/recovery, exact debit caps, immutable simulated bytes, expiry, durable finality journal, and fresh hook-aware quotes. Native guarded V2 and signed acceptance are required; there is no legacy execution fallback.</p>
      {observation && <section className="coin-observation"><h3>Read-only observation · slot {observation.inspection.observedSlot ?? 'unavailable'}</h3>
        <p>{observation.checkedAt} · not launch readiness</p>
        <ul>{observation.intent.refusals.map((r, i) => <li key={i}>{r.code}: {r.message}</li>)}</ul>
        <ul>{observation.intent.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        <details><summary>Program, config and authority identities</summary><pre>{JSON.stringify(observation.inspection, null, 2)}</pre></details>
      </section>}
      <details><summary>Local encrypted identity retention · experimental</summary>
        <p>After a matching fresh inspection, retain mint/config identities on this device. No on-chain accounts are created. AES-GCM encryption is not a backup, password reset, XSS defense or rollback protection. Device/storage/passphrase loss may be permanent. No private material goes to the server.</p>
        <p>Choose an application encryption passphrase, never your wallet seed phrase. Recovery-only unlock works without a wallet or RPC inspection, including after program upgrades; it permanently invalidates this attempt’s reviews.</p>
        <div className="coin-fields"><label>Recovery passphrase<input type="password" autoComplete="new-password" minLength={16} value={passphrase} onChange={e => setPassphrase(e.target.value)}/></label>
          <label>Repeat passphrase (new identity only)<input type="password" autoComplete="new-password" value={repeat} onChange={e => setRepeat(e.target.value)}/></label></div>
        <label className="coin-confirm"><input type="checkbox" checked={lossAccepted} onChange={e => setLossAccepted(e.target.checked)}/><span>I understand this is local retention only, not a recovery backup or launch approval.</span></label>
        <button className="button" disabled={busy || !wallet || !observation?.bindingContext || !lossAccepted || passphrase.length < 16} onClick={() => retainIdentity()}>Create or unlock local identities</button>
        <button className="button" disabled={busy} onClick={findJournals}>Find retained local journals</button>
        {journalIds.length > 0 && <><label className="coin-fields">Retained journal<select value={journalId} onChange={e => setJournalId(e.target.value)}>{journalIds.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
          <button className="button" disabled={busy || !lossAccepted || passphrase.length < 16} onClick={() => retainIdentity(true)}>Unlock for recovery only</button></>}
        {identity && <><p>Public mint</p><code>{identity.mint}</code><p>Public config</p><code>{identity.config}</code><p>Local journal ID</p><code>{identity.id}</code><button className="button" onClick={lock}>Lock identities</button></>}
      </details>
    </aside></div>
    <section className="coin-save"><div><h2>Keep the complete recipe</h2><p>{storageError || 'Autosaved on this device. Account storage is optional and expires after 30 days. Encrypted identities are never in recipe exports.'}</p>
      {!listing.signedIn && <a href="/api/github/start?mode=direct-coins">Optional GitHub account backup & provenance ↗</a>}</div>
      <button className="button primary" disabled={!ready || busy || !listing.signedIn} onClick={() => perform('save')}>Save complete account recipe</button>
    </section>
    {error && <p role="alert" className="coin-error">{error}</p>}{notice && <p role="status" className="coin-status">{notice}</p>}
    {listing.drafts.length > 0 && <section className="coin-history"><h3>Account recipes</h3>{listing.drafts.map(d => <button key={d.id} className="button" disabled={busy || !ready} onClick={() => {
      try { localStorage.setItem(accountKey, JSON.stringify({ id: d.id, revision: d.revision })); change(d.envelope); setSaved(d); saveId.current = d.id }
      catch { setError('Cannot retain the account revision safely on this device.') }
    }}>{d.envelope.recipe.coin.name || 'Untitled'} · revision {d.revision}</button>)}</section>}
    {listing.events.length > 0 && <details><summary>Recipe save audit</summary><ul>{listing.events.map(e => <li key={e.id}>Revision {e.revision} · {e.action} · {e.created_at}</li>)}</ul></details>}
  </section>
}
