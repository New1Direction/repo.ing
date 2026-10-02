'use client'
import { useId, useState } from 'react'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { parseSlippagePercent, SLIPPAGE_PRESETS_BPS, slippageLabel } from '../../src/trade-slippage.mjs'
import '../slippage.css'

// Above this the panel warns: a trade can fill that far below its quote.
const HIGH_SLIPPAGE_BPS = 500

// The trade's max slippage: presets or a custom 0.5–25%. A trade whose output would fall further below its quote than
// this fails instead of filling, so a looser setting lands more often on a fast curve at the cost of a worse fill.
// It sits inside the trade form: Enter in the custom field only commits the value, it never submits a trade.
export function SlippageSetting({ value, onChange, disabled = false }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(null)
  const id = useId()
  const preset = SLIPPAGE_PRESETS_BPS.includes(value)
  const invalid = draft !== null && draft !== '' && parseSlippagePercent(draft) === null
  function typeCustom(text) {
    setDraft(text)
    const bps = parseSlippagePercent(text)
    if (bps !== null) onChange(bps)
  }
  const note = invalid ? 'Enter a value from 0.5% to 25%.' : value > HIGH_SLIPPAGE_BPS
    ? `High: this trade can fill up to ${slippageLabel(value)} below its quote. Raise it only for a fast-moving market.`
    : `If the price moves more than ${slippageLabel(value)} before your trade lands, it fails instead of filling.`
  return <div className="slippage-setting">
    <button type="button" className="slippage-toggle" aria-expanded={open} aria-controls={`${id}-panel`} disabled={disabled}
      onClick={() => setOpen(current => !current)}>
      <SlidersHorizontal size={13} aria-hidden="true"/>Max slippage <strong className={value > HIGH_SLIPPAGE_BPS ? 'is-high' : undefined}>{slippageLabel(value)}</strong>
      <ChevronDown size={13} aria-hidden="true" className="slippage-caret"/>
    </button>
    {open && <div id={`${id}-panel`} className="slippage-panel">
      <div className="slippage-options" role="group" aria-label="Max slippage presets">
        {SLIPPAGE_PRESETS_BPS.map(bps => <button type="button" key={bps} aria-pressed={value === bps} disabled={disabled}
          onClick={() => { setDraft(null); onChange(bps) }}>{slippageLabel(bps)}</button>)}
        <label className={`slippage-custom${preset ? '' : ' is-active'}${invalid ? ' is-invalid' : ''}`}>
          <span className="sr-only">Custom max slippage in percent, 0.5 to 25</span>
          <input inputMode="decimal" autoComplete="off" placeholder="Custom" disabled={disabled} aria-invalid={invalid || undefined}
            aria-describedby={`${id}-note`} value={draft ?? (preset ? '' : String(value / 100))}
            onChange={event => typeCustom(event.target.value)} onBlur={() => setDraft(null)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}/>
          <span aria-hidden="true">%</span>
        </label>
      </div>
      <small id={`${id}-note`} className={invalid || value > HIGH_SLIPPAGE_BPS ? 'is-warning' : undefined} role="status">{note}</small>
    </div>}
  </div>
}
