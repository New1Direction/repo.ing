'use client'
import { useEffect, useState } from 'react'
import { defaultDirectPlan, directPlanSchema, DIRECT_VENUES, DEVNET_GENESIS, HOOK_LAB_COMMIT, HOOK_LAB_INTEGRATION_COMMIT, HOOK_LAB_MANIFEST_SHA256, previewDirectCoin } from '../../src/direct-coins.mjs'

const storageKey = 'repoing.direct-coin.v1'
const docs = 'https://github.com/new1direction/repo.ing/blob/main/docs/DIRECT_COINS.md'
async function api(body) {
  const response = await fetch('/api/direct-coins', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Request unavailable. No transaction was sent.')
  return data
}

export function DirectCoinPlanner() {
  const [plan, setPlan] = useState(defaultDirectPlan), [loaded, setLoaded] = useState(false)
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [localError, setLocalError] = useState('')
  const [saved, setSaved] = useState(null), [listing, setListing] = useState({ signedIn: false, drafts: [], events: [] })
  const [observation, setObservation] = useState(null)
  const parsed = directPlanSchema.safeParse(plan)
  const preview = parsed.success ? previewDirectCoin(parsed.data) : null
  const venue = DIRECT_VENUES[plan.adapter]
  const refresh = async () => { const data = await api(); setListing(data); return data }
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) { const result = directPlanSchema.safeParse(JSON.parse(raw)); if (result.success) setPlan(result.data) }
    } catch { setLocalError('Device storage is unavailable or the saved draft is invalid.') }
    setLoaded(true)
    refresh().catch(e => setError(e.message))
  }, [])
  useEffect(() => {
    if (!loaded || !parsed.success) return
    try { localStorage.setItem(storageKey, JSON.stringify(parsed.data)); setLocalError('') }
    catch { setLocalError('Device autosave failed. Keep this page open or save to your account.') }
  }, [plan, loaded])
  function change(patch) { setPlan(p => ({ ...p, ...patch })); setObservation(null); setConfirmed(false); setMessage(''); setError('') }
  function lane(value) { change({ ...defaultDirectPlan(value), name: plan.name, symbol: plan.symbol }) }
  async function perform(action) {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api({ action, plan, ...(action === 'inspect' ? { confirmedNetwork: confirmed ? 'devnet' : null }
        : saved ? { id: saved.id, revision: saved.revision } : {}) })
      if (result.draft) { setSaved(result.draft); setMessage(`Saved to your account, revision ${result.draft.revision}.`) }
      if (result.observation) { setObservation(result.observation); setMessage('Devnet read completed. This is not a transaction simulation or launch approval.') }
      await refresh()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  function resume(draft) {
    const result = directPlanSchema.safeParse(draft.plan)
    if (!result.success) { setError('This saved plan cannot be read by this version.'); return }
    setPlan(result.data); setSaved(draft); setObservation(null); setConfirmed(false); setError(''); setMessage(`Resumed revision ${draft.revision}.`)
  }
  function reset() {
    setPlan(defaultDirectPlan()); setSaved(null); setObservation(null); setConfirmed(false); setError(''); setMessage('Started an empty device draft. Account drafts are unchanged.')
  }
  return <>
    <fieldset className="coin-lanes" disabled={busy}><legend className="sr-only">Choose a coin lane</legend>
      <label className={plan.lane === 'standard' ? 'selected' : ''}><input type="radio" name="lane" checked={plan.lane === 'standard'} onChange={() => lane('standard')}/>
        <span><strong>Standard Coin</strong><small>Raydium LaunchLab by default</small><p>Standard SPL tokens. Familiar wallet support. Meteora liquidity is an advanced option.</p><em>For straightforward tokens</em></span></label>
      <label className={plan.lane === 'programmable' ? 'selected' : ''}><input type="radio" name="lane" checked={plan.lane === 'programmable'} onChange={() => lane('programmable')}/>
        <span><strong>Programmable Coin</strong><small>Hook Lab DEX · experimental devnet beta</small><p>Native hooks for custom behavior. Not SPL or Token-2022; ordinary wallets and DEXs do not automatically support it.</p><em>For supervised experimentation</em></span></label>
    </fieldset>
    <div className="coin-workspace"><section aria-labelledby="coin-plan-title">
      <h2 id="coin-plan-title">1. Define your intent</h2>
      <p className="muted">A draft is not a token. No mint, pool or market is created.</p>
      <fieldset className="coin-fields" disabled={busy}><legend className="sr-only">Coin plan</legend>
        <div className="coin-field-row"><label>Coin name<input value={plan.name} maxLength={32} onChange={e => change({ name: e.target.value })} placeholder="Your coin name" autoComplete="off"/></label>
          <label>Symbol<input value={plan.symbol} maxLength={10} onChange={e => change({ symbol: e.target.value.toUpperCase() })} placeholder="COIN" autoComplete="off"/></label></div>
        <label>Venue<select value={plan.adapter} onChange={e => change({ adapter: e.target.value })}>
          {Object.entries(DIRECT_VENUES).filter(([, v]) => v.lane === plan.lane).map(([id, v]) => <option key={id} value={id}>{v.label}{id.startsWith('meteora') ? ' (advanced)' : ''}</option>)}
        </select></label>
        <div className="coin-field-row"><label>Token standard<select value={plan.standard} onChange={e => change({ standard: e.target.value })}>
          <option value="spl">SPL Token</option><option value="token-2022">Token-2022 — not enabled</option><option value="bordrless">Hook Lab native (Bordrless)</option>
        </select></label><label>Quote asset<select value={plan.quote} onChange={e => change({ quote: e.target.value })}>
          <option value="wrapped-sol">Wrapped SOL</option><option value="bridged-sol">Hook Lab bridged SOL</option><option value="usdc">USDC — not approved</option>
        </select></label></div>
        {plan.lane === 'programmable' && <label>Recipe to evaluate<select value={plan.recipe} onChange={e => change({ recipe: e.target.value })}>
          <option value="none">Plain native coin</option><option value="kit">Kit — max-wallet limit</option><option value="halfLife">Half-Life — declining exit fee</option>
          <option value="lottery">Lottery — disabled</option><option value="custom">Arbitrary hook — unsupported</option>
        </select></label>}
        {plan.lane === 'programmable' && <>
          <label>Creator fee (basis points)<input type="number" min="0" max="10000" step="1" value={plan.creatorFeeBps ?? ''}
            onChange={e => change({ creatorFeeBps: e.target.value === '' ? null : Number(e.target.value) })} aria-describedby="coin-fee-help"/></label>
          <p id="coin-fee-help" className="coin-note">100 bps = 1%. Applies to buys and sells, in addition to protocol and hook fees. Enter 0 explicitly for no creator fee. Live limits are checked, not overridden.</p>
          {plan.recipe === 'kit' && <label>Kit max-wallet limit (basis points of supply)<input type="number" min="1" max="10000" step="1" value={plan.kitMaxWalletBps ?? ''}
            onChange={e => change({ kitMaxWalletBps: e.target.value === '' ? null : Number(e.target.value) })}/></label>}
        </>}
        <label>LP policy<select value={plan.lpPolicy} onChange={e => change({ lpPolicy: e.target.value })}>
          <option value="protocol">Use protocol/config terms (review below)</option><option value="burn">Request LP burn — not enabled</option>
          <option value="lock">Request custom lock — not enabled</option><option value="creator">Request creator ownership — not enabled</option>
        </select></label>
        <label>Network<select value={plan.network} onChange={e => change({ network: e.target.value })}>
          <option value="devnet">Solana devnet — preview only</option><option value="mainnet-beta">Mainnet — disabled</option>
        </select></label>
      </fieldset>
      {!parsed.success && <p role="alert" className="coin-error">Use a name with letters, numbers, spaces, dots, underscores or hyphens, an uppercase alphanumeric symbol, and whole-number basis points within the shown bounds.</p>}
      {preview?.refusals.length > 0 && <div role="alert" className="coin-refusal"><strong>Unsupported combination</strong><ul>{preview.refusals.map(text => <li key={text}>{text}</li>)}</ul></div>}
      <h2>2. Review what this means</h2>
      <dl className="coin-terms">{[['Liquidity / curve', venue.curve], ['LP burn, lock & ownership', venue.lp], ['Fees & costs', venue.fees], ['Custody & authorities', venue.authority],
        ...(plan.lane === 'programmable' ? [['Recipe lifecycle', preview?.recipe]] : [])].map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>
      <p className="coin-note">repo.ing is the interface. Hook Lab DEX is the native programmable venue. Hosting its interface does not make Raydium or Meteora understand Hook Lab hooks.</p>
      <details className="coin-comparison"><summary>Compare token compatibility</summary>
        <p>Raydium supports specific Token-2022 launch paths, not arbitrary extensions. This planner restricts Standard Coin to SPL.</p>
        <p>Meteora’s dedicated DBC transfer-hook path revokes the hook at graduation. DAMM v2 does not provide general active-hook account forwarding, even with a token badge.</p>
        <p>Hook Lab’s native token and pool hooks use different accounts and programs entirely. There is no automatic SPL conversion.</p>
        <a href={docs} target="_blank" rel="noreferrer">Compatibility matrix, sources and owner gates ↗</a>
      </details>
    </section>
    <aside className="coin-review" aria-labelledby="coin-review-title"><span className="badge">No transaction generated</span>
      <h2 id="coin-review-title">Your launch preview</h2><strong className="coin-preview-name">{plan.name || 'Untitled coin'} <small>{plan.symbol ? `$${plan.symbol}` : ''}</small></strong>
      <dl><div><dt>Destination</dt><dd>{venue.label}</dd></div><div><dt>Network requested</dt><dd>{plan.network}</dd></div><div><dt>Price / total cost</dt><dd>Unknown — no quote</dd></div>
        <div><dt>Simulation</dt><dd>Not run — planning only</dd></div></dl>
      <h3>Before signing can exist</h3><ul>{preview?.blockers.map(text => <li key={text}>{text}</li>)}</ul>
      <details><summary>Explicit devnet program identities</summary><p>Expected addresses, not proof of deployment. These are devnet identities even when a refused mainnet request is selected.</p>
        <p>Genesis <code>{DEVNET_GENESIS}</code></p><p>Quote mint <code>{venue.quoteMint}</code></p>
        {Object.entries(venue.programs).map(([name, address]) => <p key={name}>{name}<code>{address}</code></p>)}
        <p>{venue.sdk}</p>{plan.adapter === 'hooklab' && <>
          <p><a href={`https://github.com/New1Direction/hook-lab/commit/${HOOK_LAB_COMMIT}`} target="_blank" rel="noreferrer">ABI / deployment baseline ↗</a></p>
          <p><a href={`https://github.com/New1Direction/hook-lab/commit/${HOOK_LAB_INTEGRATION_COMMIT}`} target="_blank" rel="noreferrer">Integration delivery revision ↗</a></p>
          <p>Manifest SHA-256<code>{HOOK_LAB_MANIFEST_SHA256}</code></p>
        </>}
      </details>
      <label className="coin-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !preview?.compatible} onChange={e => setConfirmed(e.target.checked)}/>
        <span>I confirm Solana devnet for a public, read-only program check. This does not authorize spending or launching.</span></label>
      <button className="button primary" disabled={busy || !confirmed || !preview?.compatible} onClick={() => perform('inspect')}>{busy ? 'Working…' : 'Check devnet programs'}</button>
      <button className="button" disabled aria-describedby="coin-signing-note">Wallet signing unavailable</button>
      <p id="coin-signing-note" className="coin-note">No keys or seed phrases. Future approved transactions must be reviewed and wallet-signed on your device.</p>
      {observation && <section className="coin-observation"><h3>Devnet observation</h3><p>Slot {observation.slot ?? 'not observed'} · {observation.native && observation.status === 'programs-present' ? 'deployment snapshot matched (not launch readiness)' : observation.status}</p><p>{observation.checkedAt}</p>
        <ul>{observation.warnings.map(text => <li key={text}>{text}</li>)}</ul>
        {observation.native ? <HookLabObservation observation={observation}/> : <details><summary>Observed accounts & authorities</summary>{observation.programs.map(p => <div key={p.name}><strong>{p.name}: {p.executable ? 'executable' : 'missing / not executable'}</strong>
          <code>{p.address}</code><p>Owner <code>{p.owner || 'unknown'}</code></p><p>ProgramData <code>{p.programData || 'unknown'}</code></p>
          <p>Upgrade: {p.authorityStatus}<code>{p.upgradeAuthority || 'none reported'}</code></p></div>)}</details>}
      </section>}
    </aside></div>
    <section className="coin-save" aria-label="Drafts and audit trail"><div><h2>Keep your plan, not your keys.</h2>
      <p>{localError || (loaded ? 'Autosaved on this device. Account drafts and audit records expire after 30 days.' : 'Loading device draft…')}</p>
      {!listing.signedIn && <a href="/api/github/start?mode=direct-coins">Sign in with GitHub for account drafts and devnet checks ↗</a>}</div>
      <div className="coin-actions"><button className="button" disabled={busy} onClick={reset}>Reset device draft</button>
        <button className="button primary" disabled={busy || !parsed.success || !listing.signedIn} onClick={() => perform('save')}>Save account draft</button></div>
    </section>
    <div role="status" aria-live="polite" className="coin-status">{message}</div>{error && <p role="alert" className="coin-error">{error}</p>}
    {listing.signedIn && <details className="coin-history"><summary>Saved drafts & private audit trail</summary>
      <button className="button" disabled={busy} onClick={() => refresh().catch(e => setError(e.message))}>Reload account drafts</button>
      {listing.drafts.length === 0 && <p>No account drafts saved yet.</p>}
      {listing.drafts.map(draft => <button className="button" key={draft.id} disabled={busy} onClick={() => resume(draft)}>{draft.plan.name || 'Untitled'} · revision {draft.revision}</button>)}
      <ol>{listing.events.map(event => <li key={event.id}>{event.action} · {event.adapter} · {event.outcome} · {event.created_at}{event.revision ? ` · revision ${event.revision}` : ''}<code>Plan SHA-256 {event.plan_hash}</code></li>)}</ol>
    </details>}
  </>
}

function HookLabObservation({ observation }) {
  const { inspection, intent, intentRefusals } = observation.native
  return <>
    <p>Finalized read-only snapshot. Matched absence of a deferred program does not enable that feature. State can change after this slot.</p>
    {inspection.refusals.length > 0 && <div className="coin-refusal" role="alert"><strong>Inspection refused</strong><ul>{inspection.refusals.map((r, i) => <li key={i}>{r.code} · {r.subject}: {r.message}</li>)}</ul></div>}
    <details><summary>Binary hashes & upgrade authorities</summary>{observation.programs.map(p => <div key={p.role}>
      <strong>{p.role}: {p.status} · expected {p.expectedStatus}</strong><code>{p.programId}</code>
      <p>Executable hash<code>{p.binaryHash ?? 'none observed'}</code></p><p>Upgrade authority<code>{p.upgradeAuthority ?? 'none observed'}</code></p>
    </div>)}</details>
    <details><summary>Observed economics, quote & lookup table</summary><p>Decoded values, not approved costs. Large integers are decimal strings; basis points and raw token units are not SOL amounts.</p>
      {Object.entries(inspection.accounts).map(([name, account]) => <details key={name}><summary>{name}</summary><code>{account.address}</code>
        <p>Account SHA-256<code>{account.dataSha256}</code></p><code>{JSON.stringify(account.decoded)}</code></details>)}
    </details>
    <h3>Native intent preview</h3>
    {intentRefusals.length > 0 && <ul>{intentRefusals.map(text => <li key={text}>{text}</li>)}</ul>}
    {intent && <>
      {intent.refusals.length > 0 ? <div className="coin-refusal" role="alert"><strong>Intent refused</strong><ul>{intent.refusals.map((r, i) => <li key={i}>{r.code}: {r.message}</li>)}</ul></div>
        : <><p>Validated {intent.recipe} intent only — no executable messages.</p><ol>{intent.steps.map(step => <li key={step.index}>{step.description}</li>)}</ol></>}
      <ul>{intent.warnings.filter(w => !inspection.warnings.includes(w)).map(w => <li key={w}>{w}</li>)}</ul>
      <p>Total wallet debit, rent, network fees, minimum output and expiry: unknown.</p><p>{intent.recovery}</p>
      <p>Future mint/config keys must be generated and retained on your device. No keys are requested or generated now.</p>
    </>}
    <p>Trading, transaction generation, signing and sending remain unavailable. No approved external builder handoff is configured.</p>
  </>
}
