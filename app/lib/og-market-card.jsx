import { ogText } from './og-card.mjs'
import { Frame, MarketLogo, colors } from './og-image'
import { HF_DISCLAIMER_SHORT, isModelMarket } from './hf-model-display.mjs'

// The token page's link-preview card (app/(site)/token/[mint]/opengraph-image). A Hugging Face model market's card says
// so, names who its fees pay, and carries the disclaimer.
const MODEL_FRAME = { tagline: 'Hugging Face model market', footer: 'Every trade pays the model’s owner in SOL.' }

export function MarketCard({ market, logo, stats }) {
  const symbol = ogText(market.symbol, 14), name = ogText(market.fullName, 48), model = isModelMarket(market)
  return <Frame {...(model ? MODEL_FRAME : {})}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 36, marginTop: 44 }}>
      <MarketLogo logo={logo} symbol={symbol}/>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 860 }}>
        <span style={{ fontSize: 34, color: colors.muted }}>{name}</span>
        <strong style={{ fontSize: 76, letterSpacing: '-2px' }}>${symbol}</strong>
      </div>
    </div>
    {stats.length ? <div style={{ display: 'flex', gap: 72, marginTop: 42 }}>{stats.map(stat => <div key={stat.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 22, color: colors.muted, textTransform: 'uppercase', letterSpacing: '3px' }}>{stat.label}</span>
      <strong style={{ fontSize: 52, color: colors.green, letterSpacing: '-1px' }}>{stat.value}</strong>
    </div>)}</div>
      : <span style={{ fontSize: 28, lineHeight: 1.4, color: colors.muted, marginTop: 42 }}>{ogText(market.description || (model ? 'Trade this Hugging Face model market on repo.ing.' : 'Trade this open source repository market on repo.ing.'), 120)}</span>}
    {model && <span style={{ display: 'flex', marginTop: 26, fontSize: 22, color: colors.muted }}>{HF_DISCLAIMER_SHORT}</span>}
  </Frame>
}
