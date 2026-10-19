// Starting price of a USD-priced Hooks launch in plain words: the coin's market value when trading opens and when it
// graduates, and the SOL buyers put in on the way. price: { solUsdMicros, virtualQuote }, either today's estimate or
// the price fixed when repo.ing invited the coin (fixed), or null when no SOL price is known (the USD targets alone).
import { Info } from 'lucide-react'
import { TARGET_USD_MICROS, formatSol, formatSolPrice, formatUsd, launchValues } from '../../src/hooklab-launch-pricing.mjs'

function priceRows(price) {
  const v = price && launchValues(price.virtualQuote, price.solUsdMicros)
  return [
    ['Starts at', 'The coin’s market value when trading opens', `≈${formatUsd(v ? v.openingUsdMicros : TARGET_USD_MICROS.opening)}`],
    ['Graduates at', 'Its market value when the launch sells out', `≈${formatUsd(v ? v.graduationUsdMicros : TARGET_USD_MICROS.graduation)}`],
    ['Raised to graduate', 'The SOL buyers put in before it graduates', v ? formatSol(v.raiseLamports) : `≈${formatUsd(TARGET_USD_MICROS.raise)}`],
  ]
}
const priceNote = (price, fixed) => fixed ? `Locked in when repo.ing approved your coin, with SOL at ${formatSolPrice(price.solUsdMicros)}.`
  : price ? `SOL amounts use today’s price of ${formatSolPrice(price.solUsdMicros)} per SOL. repo.ing locks them in when it approves your coin.`
    : 'The SOL amount is set from SOL’s price when repo.ing approves your coin.'

// The launch form's side card, styled like "Every trade" below it.
export function HookStartingPrice({ price, fixed = false }) {
  return <div className="inner-card fee-breakdown hooks-price"><h3>Starting price</h3>
    {priceRows(price).map(([label, about, value]) => <div key={label} className="fee-line"><span>{label}<small>{about}</small></span><strong>{value}</strong></div>)}
    <div className="fee-note"><Info size={18} aria-hidden="true"/><span>{priceNote(price, fixed)}</span></div>
  </div>
}

// The request status: the same three numbers as compact stats.
export function HookPriceStats({ price, fixed = false }) {
  return <>
    <dl className="hooks-coin-stats hooks-price-stats" aria-label="Starting price">
      {priceRows(price).map(([label, , value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    <p className="hooks-price-note">{priceNote(price, fixed)}</p>
  </>
}
