'use client'
import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { BUY_PRESETS_KEY, DEFAULT_BUY_PRESETS, validateBuyPresets } from '../lib/buy-presets.mjs'
import { canAffordBuy, sameAmount } from '../lib/quick-amounts.mjs'

export function BuyPresets({ disabled, amount, solBalance, onSelect }) {
  const [values, setValues] = useState(DEFAULT_BUY_PRESETS)
  const [draft, setDraft] = useState(DEFAULT_BUY_PRESETS)
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    try { setValues(validateBuyPresets(JSON.parse(localStorage.getItem(BUY_PRESETS_KEY)))) } catch {}
  }, [])
  function save() {
    try {
      const next = validateBuyPresets(draft)
      setValues(next)
      try { localStorage.setItem(BUY_PRESETS_KEY, JSON.stringify(next)); setMessage('Presets saved on this device.') }
      catch { setMessage('Presets saved for this visit. Device storage is unavailable.') }
      setEditing(false)
    } catch (error) { setMessage(error.message) }
  }
  return <div className={`buy-presets${editing ? ' is-editing' : ''}`}>
    <div className="trade-quick-actions" role="group" aria-label="Buy amount shortcuts">{values.map(value => <button type="button" key={value} disabled={disabled || !canAffordBuy(value, solBalance)} aria-pressed={sameAmount(amount, value, 9)} aria-label={`Buy ${value} SOL`} onClick={() => { setMessage(''); onSelect(value) }}>{value} SOL</button>)}<button type="button" className="buy-presets-edit" aria-label="Edit buy presets" aria-expanded={editing} aria-controls="buy-preset-editor" disabled={disabled} onClick={() => { setDraft(values); setMessage(''); setEditing(!editing) }}><Pencil size={12} aria-hidden="true"/></button></div>
    {editing && <fieldset id="buy-preset-editor" className="preset-editor" disabled={disabled} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); save() } if (event.key === 'Escape') { event.preventDefault(); setEditing(false) } }}><legend>Buy presets · SOL</legend><div className="preset-fields">{draft.map((value, index) => <label key={index}><span className="sr-only">Preset {index + 1} in SOL</span><input inputMode="decimal" autoComplete="off" value={value} maxLength={22} onChange={event => setDraft(draft.map((v, i) => i === index ? event.target.value : v))}/></label>)}</div><small>Shortcuts only. Every trade needs your wallet approval.</small><div className="preset-actions"><button type="button" onClick={() => setDraft(DEFAULT_BUY_PRESETS)}>Reset</button><button type="button" onClick={() => setEditing(false)}>Cancel</button><button type="button" onClick={save}>Save</button></div></fieldset>}
    {message && <small className="preset-message" role="status">{message}</small>}
  </div>
}
