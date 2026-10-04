import { ogText } from './og-card.mjs'
import { formatReturn } from './share-links.mjs'
import { Frame, MarketLogo, colors } from './og-image'
import { HF_DISCLAIMER_SHORT, isModelMarket } from './hf-model-display.mjs'
import { stockPairFeeLine } from '../../src/stock-owner-claims.mjs'

// Link-preview card for a shared return. It is labelled as the sharer's own figure: the URL is editable. A Hugging Face
// model market's card names who its fees pay and carries the disclaimer in its footer; a stock pair's footer says what its
// trades pay, in its stock.
const LOGO = 112
const MODEL_FRAME = { tagline: 'Hugging Face model market', footer: HF_DISCLAIMER_SHORT }

export function ReturnCard({ market, logo, pct }) {
  const symbol = ogText(market.symbol, 14), name = ogText(market.fullName, 52), value = formatReturn(pct)
  const color = pct > 0 ? colors.green : pct < 0 ? colors.red : colors.text
  const stockLine = stockPairFeeLine(market)
  return <Frame {...(isModelMarket(market) ? MODEL_FRAME : stockLine ? { footer: stockLine } : {})}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 28, marginTop: 36 }}>
      <MarketLogo logo={logo} symbol={symbol} size={LOGO}/>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 880 }}>
        <strong style={{ fontSize: 56, letterSpacing: '-1.5px' }}>${symbol}</strong>
        <span style={{ fontSize: 30, color: colors.muted }}>{name}</span>
      </div>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 30 }}>
      <span style={{ fontSize: 24, color: colors.muted, textTransform: 'uppercase', letterSpacing: '3px' }}>My return on ${symbol}</span>
      <strong style={{ fontSize: value.length > 9 ? 124 : 150, lineHeight: 1.05, letterSpacing: '-5px', color }}>{value}</strong>
    </div>
  </Frame>
}
