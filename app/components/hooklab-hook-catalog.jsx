'use client'
import { useEffect, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import { HooksOperationError } from './hooks-ui'

const endpoint = '/api/hook-lab/hook-catalog'
async function call(body) {
  const response = await fetch(endpoint, { cache: 'no-store', credentials: 'same-origin', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  const value = await response.json()
  if (!response.ok) throw Error(value.error || 'Hook catalogue unavailable.')
  return value
}
function Declaration({ publication: p }) {
  return <div className="launch-buy-hint" style={{ overflowWrap: 'anywhere' }}>
    <p><strong>{p.name} · {p.version}</strong></p>
    <p>Publisher wallet (not verified author): {p.publisher}</p>
    <p>Declared behavior: {p.behavior}</p><p>Declared fees: {p.fees}</p><p>Declared risks: {p.risks}</p>
    <details><summary>Technical details</summary><p>Program: {p.selectedHook.program} · Flags: {p.selectedHook.flags}</p>
      <p>Publication digest: {p.digest}</p><p>Executable digest: {p.executableSha256} · {p.authority}</p></details>
  </div>
}
export function HookCatalogSelector({ form, set, disabled }) {
  const [publications, update] = useState([]), [error, fail] = useState(''), [busy, working] = useState(false)
  const [query, search] = useState(''), [direct, draft] = useState({ program: form.selectedHook?.program ?? '', flags: form.selectedHook?.flags ?? '' })
  useEffect(() => { let active = true; call().then(v => { if (active) update(v.publications) }).catch(e => { if (active) fail(e.message) }); return () => { active = false } }, [])
  async function choose(digest) {
    fail(''); working(true)
    try {
      const { publication: p } = await call({ action: 'select', digest })
      const configuration = Object.fromEntries(p.manifest.fields.map(f => [f.name, f.type === 'bool' ? false : '']))
      set({ hookKind: 'selected', capBps: 0, selectedHook: p.selectedHook, hookPublication: { digest: p.digest, manifest: p.manifest, configuration } })
    } catch (e) { fail(e.message) } finally { working(false) }
  }
  function applyDirect() {
    try {
      const program = new PublicKey(direct.program).toBase58(), flags = Number(direct.flags)
      if (program !== direct.program || program === '11111111111111111111111111111111' || !/^\d+$/.test(String(direct.flags)) || !Number.isInteger(flags) || flags < 1 || flags > 255) throw Error()
      set({ hookKind: 'selected', capBps: 0, selectedHook: { program, flags }, hookPublication: undefined }); fail('')
    } catch { fail('Enter a valid hook program address and callback flags from 1 to 255.') }
  }
  const selected = publications.find(p => p.digest === form.hookPublication?.digest)
  return <article className="hooks-block" aria-label="Custom hook configuration" aria-busy={busy}>
    <p className="launch-buy-hint">Publications are declarations, not endorsements. Publisher wallets are not verified authors. Compatibility is rechecked on selection and execution; additional token fees and transfer restrictions may apply.</p>
    {form.selectedHook?.program && <details><summary>Selected hook details</summary><p className="launch-buy-hint" style={{ overflowWrap: 'anywhere' }}>Selected program: {form.selectedHook.program} · Flags: {form.selectedHook.flags}{form.hookPublication && <> · Publication digest: {form.hookPublication.digest}</>}</p></details>}
    <p><a href="/hooks/publish">Publish a hook or a new version</a></p>
    <label className="field-label" htmlFor="hook-catalog-search">Find a hook</label>
    <input id="hook-catalog-search" className="field-input" value={query} onChange={e => search(e.target.value)} placeholder="Name, program or publisher" disabled={disabled || busy}/>
    <label className="field-label" htmlFor="hook-catalog-choice">Published hook version</label>
    <select id="hook-catalog-choice" className="field-input" value={form.hookPublication?.digest ?? ''} disabled={disabled || busy} onChange={e => { if (e.target.value) choose(e.target.value) }}>
      <option value="">Choose a publication</option>
      {publications.filter(p => p.digest === form.hookPublication?.digest || `${p.name} ${p.selectedHook.program} ${p.publisher}`.toLowerCase().includes(query.toLowerCase())).map(p => <option key={p.digest} value={p.digest}>{p.name} · {p.version} · {p.selectedHook.program}</option>)}
    </select>
    {!publications.length && <p className="launch-buy-hint">No publications loaded. Developers can publish compatible hooks without a platform release.</p>}
    {selected && <Declaration publication={selected}/>}
    {form.hookPublication && <fieldset disabled={disabled || busy}><legend className="field-label">Hook setup configuration</legend>
      {form.hookPublication.manifest.fields.map(f => <label className="field-label" key={f.name} htmlFor={`hook-config-${f.name}`}>{f.label}
        <input id={`hook-config-${f.name}`} className="field-input" type={f.type === 'bool' ? 'checkbox' : 'text'} inputMode={f.type.startsWith('u') ? 'numeric' : undefined}
          aria-label={f.label} aria-describedby={f.min !== undefined || f.max !== undefined ? `hook-config-${f.name}-bounds` : undefined}
          {...(f.type === 'bool' ? { checked: !!form.hookPublication.configuration[f.name] } : { value: form.hookPublication.configuration[f.name] ?? '' })}
          onChange={e => set({ hookPublication: { ...form.hookPublication, configuration: { ...form.hookPublication.configuration, [f.name]: f.type === 'bool' ? e.target.checked : e.target.value } } })}/>
        {f.min !== undefined || f.max !== undefined ? <small id={`hook-config-${f.name}-bounds`}>Allowed: {f.min ?? '0'}–{f.max ?? f.type}</small> : null}
      </label>)}
      <p className="launch-buy-hint">These settings are saved with your launch and cannot be changed during recovery. Hook setup requires approval from your creator wallet only.</p>
    </fieldset>}
    <details><summary>Advanced: direct compatible hook</summary>
      <p className="launch-buy-hint">For hooks with an already prepared registry. Direct metadata is not executable evidence or permission to launch. Server compatibility checks still apply.</p>
      <label className="field-label" htmlFor="hook-program">Hook program</label><input id="hook-program" className="field-input" value={direct.program} disabled={disabled || busy} autoComplete="off" spellCheck={false} onChange={e => draft({ ...direct, program: e.target.value })}/>
      <label className="field-label" htmlFor="hook-flags">Callback flags (1–255)</label><input id="hook-flags" className="field-input" inputMode="numeric" value={direct.flags} disabled={disabled || busy} onChange={e => draft({ ...direct, flags: e.target.value })}/>
      <button type="button" className="button outline" disabled={disabled || busy} onClick={applyDirect}>Use direct hook metadata</button>
    </details>
    <div aria-live="polite"><HooksOperationError error={error}/></div>
  </article>
}

export function HookCatalogPublisher() {
  const [form, update] = useState({ name: '', version: '', program: '', flags: '', behavior: '', fees: '', risks: '', manifest: '' })
  const [error, fail] = useState(''), [result, published] = useState(null), [busy, working] = useState(false)
  const [publications, catalog] = useState([]), [catalogError, catalogFail] = useState('')
  useEffect(() => { let active = true; call().then(v => { if (active) catalog(v.publications) }).catch(e => { if (active) catalogFail(e.message) }); return () => { active = false } }, [])
  async function submit(e) {
    e.preventDefault(); fail(''); published(null); working(true)
    try {
      const { program, flags, manifest, ...declarations } = form
      const value = await call({ action: 'publish', publication: { ...declarations, selectedHook: { program, flags: Number(flags) }, manifest: JSON.parse(manifest) } })
      published(value.publication)
      catalog(items => [value.publication, ...items.filter(p => p.digest !== value.publication.digest)])
    } catch (cause) { fail(cause instanceof SyntaxError ? 'Enter a valid JSON setup manifest.' : cause.message) } finally { working(false) }
  }
  return <section className="inner-card"><h2>Developer publication</h2>
    <p className="launch-buy-hint">Sign in above. Publication records the wallet controlling that session. Declare all fees and restrictions. Each program/version is append-only per publisher; changing code, declarations or setup requires a new version. Executables must be immutable or protected by the supported idle timelock.</p>
    <form onSubmit={submit} aria-busy={busy}><fieldset disabled={busy}><legend className="field-label">Hook declaration</legend>
      {Object.entries({ name: 'Hook name', version: 'Immutable version', program: 'Hook program address', flags: 'Callback flags (1–255)', behavior: 'Declared behavior', fees: 'Declared fees (including token fees)', risks: 'Declared risks and restrictions', manifest: 'Declarative setup manifest (JSON)' }).map(([key, label]) => <label className="field-label" htmlFor={`publish-${key}`} key={key}>{label}
        {['behavior','fees','risks','manifest'].includes(key) ? <textarea id={`publish-${key}`} className="field-input" rows={key === 'manifest' ? 12 : 3} required value={form[key]} maxLength={key === 'manifest' ? 40000 : key === 'fees' ? 2000 : 4000} onChange={e => update({ ...form, [key]: e.target.value })}/> : <input id={`publish-${key}`} className="field-input" required value={form[key]} maxLength={key === 'name' ? 100 : 64} onChange={e => update({ ...form, [key]: e.target.value })}/>}
      </label>)}
      <details><summary>Setup manifest format</summary><p className="launch-buy-hint">Schema: repoing/hook-setup-manifest/1. Include selectedHook, fields and instructions. Fields support u8/u16/u32/u64 (decimal strings), address and bool. Each instruction contains data segments (bytes with hex, or field with name) and accounts (source, signer, writable). Account sources: creator, mint, fixed with address, field with name, or pda with program and seeds. PDA program is selectedHook or a fixed address. Seeds use bytes, creator, mint, fixed or field. Only creator may sign; no instruction program override or JavaScript. Integers are little-endian. No setup instruction may write the mint, executable or system program. Server derives every address again. A tax-hook prepare example is exported by taxHookSetupManifest in the server module; its collector holding is created atomically with the mint in the launch transaction.</p></details>
      <button className="button primary" type="submit">{busy ? 'Checking compatibility…' : 'Publish immutable version'}</button>
    </fieldset></form>
    <div aria-live="polite"><HooksOperationError error={error}/>{result && <><p role="status">Published. Creators can discover this version in the hook selector.</p><Declaration publication={result}/></>}</div>
    <section aria-labelledby="published-hook-list"><h2 id="published-hook-list">Published hooks</h2>
      <p className="launch-buy-hint">Public discovery needs no wallet sign-in. These are publisher declarations, not endorsements. Executable compatibility must still be revalidated before use. Showing the latest 100 versions.</p>
      <HooksOperationError error={catalogError}/>
      {publications.map(p => <details key={p.digest}><summary>{p.name} · {p.version} · {p.publisher}</summary><Declaration publication={p}/></details>)}
    </section>
  </section>
}
