'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ImagePlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { PartsDialog, centsLabel, postJson } from './parts-fund-dialog'

const API = '/api/parts-fund/manage'
const FAILED = 'The parts list could not be updated. Refresh and try again.'
const MAX_GOAL_CENTS = 500_000, MAX_ITEMS = 25
const blankItem = () => ({ key: crypto.randomUUID(), name: '', url: '', unitPrice: '', quantity: '1' })
const cents = value => /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/.test(value.trim()) ? Math.round(Number(value) * 100) : 0
const fromFund = fund => fund ? {
  title: fund.title, description: fund.description ?? '', durationDays: '30',
  items: fund.items.map(item => ({ key: item.id, name: item.name, url: item.url ?? '', unitPrice: (item.unitPriceCents / 100).toFixed(2).replace(/\.00$/, ''), quantity: String(item.quantity) })),
} : { title: '', description: '', durationDays: '30', items: [blankItem()] }

// Create or edit (before the first pledge) a parts list. The server re-validates everything and re-checks GitHub admin.
export function PartsFundEditor({ repoId, fund = null, label }) {
  const router = useRouter()
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [form, setForm] = useState(() => fromFund(fund))
  const set = patch => setForm(current => ({ ...current, ...patch }))
  const setItem = (key, patch) => setForm(current => ({ ...current, items: current.items.map(item => item.key === key ? { ...item, ...patch } : item) }))
  const goal = form.items.reduce((sum, item) => sum + cents(item.unitPrice) * (Number(item.quantity) || 0), 0)
  async function save(event) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const list = { title: form.title, description: form.description, durationDays: Number(form.durationDays),
        items: form.items.map(({ name, url, unitPrice, quantity }) => ({ name, url: url.trim() || null, unitPrice: unitPrice.trim(), quantity: Number(quantity) })) }
      await postJson(API, fund ? { action: 'edit', repoId, fundId: fund.id, list } : { action: 'create', repoId, list }, FAILED)
      setOpen(false); router.refresh()
    } catch (cause) { setError(cause.message) }
    finally { setBusy(false) }
  }
  return <>
    <button type="button" className={fund ? 'parts-link-button' : 'button outline parts-start'} aria-haspopup="dialog" onClick={() => { setForm(fromFund(fund)); setOpen(true) }}>
      {fund ? <Pencil size={14} aria-hidden="true"/> : <Plus size={16} aria-hidden="true"/>}{label ?? (fund ? 'Edit list' : 'Start a parts fund')}</button>
    {open && <PartsDialog eyebrow={fund ? 'Edit parts list' : 'New parts fund'} title={fund ? fund.title : 'What does the build need?'} busy={busy} wide onClose={() => !busy && setOpen(false)}>
      <form className="parts-form" onSubmit={save}>
        <label><span>Title</span><input value={form.title} maxLength={100} required onChange={e => set({ title: e.target.value })} placeholder="Robot arm v2 parts"/></label>
        <label><span>Description <small>optional</small></span><textarea value={form.description} maxLength={1000} rows={3} onChange={e => set({ description: e.target.value })}
          placeholder="What you are building and why these parts."/></label>
        <fieldset className="parts-items-editor"><legend>Parts</legend>
          {form.items.map((item, index) => <div className="parts-item-row" key={item.key}>
            <input aria-label={`Part ${index + 1} name`} value={item.name} maxLength={80} required placeholder="Part name" onChange={e => setItem(item.key, { name: e.target.value })}/>
            <input aria-label={`Part ${index + 1} purchase link`} value={item.url} maxLength={500} inputMode="url" placeholder="https:// link (optional)" onChange={e => setItem(item.key, { url: e.target.value })}/>
            <span className="parts-money"><span aria-hidden="true">$</span><input aria-label={`Part ${index + 1} unit price in dollars`} value={item.unitPrice} inputMode="decimal" required placeholder="0.00"
              onChange={e => setItem(item.key, { unitPrice: e.target.value.replace(/[^\d.]/g, '') })}/></span>
            <input aria-label={`Part ${index + 1} quantity`} className="parts-qty" value={item.quantity} inputMode="numeric" required onChange={e => setItem(item.key, { quantity: e.target.value.replace(/\D/g, '').slice(0, 3) })}/>
            <button type="button" className="parts-icon-button" aria-label={`Remove part ${index + 1}`} disabled={form.items.length === 1}
              onClick={() => set({ items: form.items.filter(i => i.key !== item.key) })}><Trash2 size={15}/></button>
          </div>)}
          <button type="button" className="parts-link-button" disabled={form.items.length >= MAX_ITEMS} onClick={() => set({ items: [...form.items, blankItem()] })}><Plus size={14} aria-hidden="true"/>Add a part</button>
        </fieldset>
        <div className="parts-form-foot">
          <label className="parts-select"><span>Deadline</span><select value={form.durationDays} onChange={e => set({ durationDays: e.target.value })}>
            {[7, 14, 21, 30, 45, 60].map(days => <option key={days} value={days}>{days} days</option>)}</select></label>
          <p className={goal > MAX_GOAL_CENTS ? 'tip-warning' : ''}>Goal <strong>{centsLabel(goal)}</strong><small>{goal > MAX_GOAL_CENTS ? 'Lists are capped at $5,000 for now' : 'Sum of the parts · cap $5,000'}</small></p>
        </div>
        {error && <p className="wallet-dialog-error" role="alert">{error}</p>}
        <button type="submit" className="button primary tip-submit" disabled={busy || goal > MAX_GOAL_CENTS || goal <= 0}>{busy ? 'Checking GitHub access…' : fund ? 'Save changes' : 'Publish parts list'}</button>
        <p className="tip-fineprint">All or nothing: pledges are paid to your payout wallet only if the list is fully funded by the deadline (or when you close & collect after it is). Otherwise every backer is refunded automatically. You can edit the list until the first pledge.</p>
      </form>
    </PartsDialog>}
  </>
}

// Maintainer controls on the card: close & collect (goal met), cancel (→ refunds), send now (closed lists), post update.
export function PartsFundActions({ repoId, fund, review }) {
  const router = useRouter()
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [confirmCancel, setConfirmCancel] = useState(false), [results, setResults] = useState(null)
  async function run(action, extra = {}) {
    setBusy(action); setError(''); setResults(null)
    try {
      const result = await postJson(API, { action, repoId, fundId: fund.id, ...extra }, FAILED)
      setResults(result.transfers ?? null); setConfirmCancel(false); router.refresh()
    } catch (cause) { setError(cause.message) }
    finally { setBusy('') }
  }
  const open = fund.status === 'open', pastDeadline = new Date(fund.deadline).getTime() <= Date.now()
  const owes = !fund.settledAt && (!open || pastDeadline)
  return <div className="parts-manage" aria-label="Maintainer controls">
    <span className="parts-manage-label">Maintainer</span>
    <div className="parts-manage-buttons">
      {open && fund.goalMet && review && <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => run('collect', { review })}>{busy === 'collect' ? 'Collecting…' : 'Close & collect'}</button>}
      {owes && <button type="button" className="button outline" disabled={Boolean(busy)} onClick={() => run('settle')}>{busy === 'settle' ? 'Sending…' : fund.status === 'funded' ? 'Send payout now' : 'Send refunds now'}</button>}
      {fund.status === 'funded' && <PartsUpdateComposer repoId={repoId} fundId={fund.id}/>}
      {open && fund.backers === 0 && <PartsFundEditor repoId={repoId} fund={fund}/>}
      {fund.settledAt && <PartsFundEditor repoId={repoId} label="Start a new parts fund"/>}
      {open && !confirmCancel && <button type="button" className="parts-link-button danger" disabled={Boolean(busy)} onClick={() => setConfirmCancel(true)}>Cancel list</button>}
    </div>
    {confirmCancel && <div className="parts-confirm" role="alert"><p>Cancel this list? Every pledge is refunded to its backer. This cannot be undone.</p>
      <div><button type="button" className="button outline danger" disabled={Boolean(busy)} onClick={() => run('cancel')}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel and refund'}</button>
        <button type="button" className="parts-link-button" disabled={Boolean(busy)} onClick={() => setConfirmCancel(false)}>Keep it open</button></div></div>}
    {results?.length > 0 && <ul className="claim-tips-results" role="status">{results.map((r, i) => <li key={`${r.signature ?? i}`}>{r.status === 'failed'
      ? <span className="inline-error">{r.error}</span>
      : <a href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noopener noreferrer">{r.kind === 'refund' ? 'Refund' : 'Payout'} {r.status === 'settled' ? 'sent' : 'sent, confirming'} ↗</a>}</li>)}</ul>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>
}

function PartsUpdateComposer({ repoId, fundId }) {
  const router = useRouter()
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [body, setBody] = useState(''), [images, setImages] = useState([''])
  async function post(event) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      await postJson(API, { action: 'update', repoId, fundId, update: { body, images: images.map(v => v.trim()).filter(Boolean) } }, FAILED)
      setOpen(false); setBody(''); setImages(['']); router.refresh()
    } catch (cause) { setError(cause.message) }
    finally { setBusy(false) }
  }
  return <>
    <button type="button" className="button outline" aria-haspopup="dialog" onClick={() => setOpen(true)}>Post build update</button>
    {open && <PartsDialog eyebrow="Build update" title="How is the build going?" busy={busy} onClose={() => !busy && setOpen(false)}>
      <form className="parts-form" onSubmit={post}>
        <label><span>Update <small>{body.length}/1000</small></span><textarea value={body} maxLength={1000} rows={5} required onChange={e => setBody(e.target.value)}
          placeholder="Parts arrived, first assembly photos below."/></label>
        <fieldset className="parts-image-links"><legend>Images <small>GitHub or Imgur links, up to 4</small></legend>
          {images.map((value, index) => <input key={index} aria-label={`Image link ${index + 1}`} value={value} inputMode="url" placeholder="https://i.imgur.com/… or https://github.com/user-attachments/assets/…"
            onChange={e => setImages(images.map((v, i) => i === index ? e.target.value : v))}/>)}
          {images.length < 4 && <button type="button" className="parts-link-button" onClick={() => setImages([...images, ''])}><ImagePlus size={14} aria-hidden="true"/>Add image link</button>}
        </fieldset>
        {error && <p className="wallet-dialog-error" role="alert">{error}</p>}
        <button type="submit" className="button primary tip-submit" disabled={busy || !body.trim()}>{busy ? 'Posting…' : 'Post update'}</button>
      </form>
    </PartsDialog>}
  </>
}

// Share one build update: copy its link, or post it on X.
export function PartsUpdateShare({ mint, updateId, title }) {
  const [copied, setCopied] = useState(false)
  const url = () => `${window.location.origin}/token/${encodeURIComponent(mint)}#parts-update-${updateId}`
  async function copy() {
    try { await navigator.clipboard.writeText(url()); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { setCopied(false) }
  }
  const x = () => window.open(`https://x.com/intent/post?${new URLSearchParams({ text: `Build update: ${title.slice(0, 80)} — backed on @repodoting`, url: url() })}`, '_blank', 'noopener,noreferrer')
  return <span className="parts-share"><button type="button" className="parts-link-button" onClick={copy}>{copied ? 'Link copied' : 'Copy link'}</button>
    <button type="button" className="parts-link-button" onClick={x}>Share on X</button></span>
}
