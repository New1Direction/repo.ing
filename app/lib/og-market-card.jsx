import { ogStatsTime, ogText } from './og-card.mjs'
import { Frame, FrameNotice, MarketLogo, colors } from './og-image'
import { HF_DISCLAIMER_SHORT, isModelMarket } from './hf-model-display.mjs'
import { declinedFooter, declinedLabel } from './declined-display.mjs'
import { stockPairFeeLine } from '../../src/stock-owner-claims.mjs'

// The token page's link-preview card (app/(site)/token/[mint]/opengraph-image). A Hugging Face model market's card says
// so, names who its fees pay, and carries the disclaimer. A stock pair's footer says what its trades pay, in its stock.
const MODEL_FRAME = { tagline: 'Hugging Face model market', footer: 'Every trade pays the model’s owner in SOL.' }

// at: when stats were read; printed beside them, because apps show a saved copy of the card long after. declined: the market's
// maintainer (or model owner) declined it: the header says so in red and the footer no longer says that trades pay the builders.
export function MarketCard({ market, logo, stats, at = null, declined = false }) {
  const symbol = ogText(market.symbol, 14), name = ogText(market.fullName, 48), model = isModelMarket(market), stockLine = stockPairFeeLine(market)
  const time = ogStatsTime(at)
  return <Frame {...(model ? MODEL_FRAME : stockLine ? { footer: stockLine } : {})}
    {...(declined ? { notice: <FrameNotice>{declinedLabel(market)}</FrameNotice>, footer: <span style={{ color: colors.muted }}>{declinedFooter(market)}</span> } : {})}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 36, marginTop: 44 }}>
      <MarketLogo logo={logo} symbol={symbol}/>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 860 }}>
        <span style={{ fontSize: 34, color: colors.muted }}>{name}</span>
        <strong style={{ fontSize: 76, letterSpacing: '-2px' }}>${symbol}</strong>
      </div>
    </div>
    {stats.length ? <div style={{ display: 'flex', alignItems: 'flex-end', gap: 72, marginTop: 42 }}>{stats.map(stat => <div key={stat.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 22, color: colors.muted, textTransform: 'uppercase', letterSpacing: '3px' }}>{stat.label}</span>
      <strong style={{ fontSize: 52, color: colors.green, letterSpacing: '-1px' }}>{stat.value}</strong>
    </div>)}{time ? <span style={{ display: 'flex', marginLeft: 'auto', paddingBottom: 12, fontSize: 22, color: colors.muted }}>{`As of ${time}`}</span> : null}</div>
      : <span style={{ fontSize: 28, lineHeight: 1.4, color: colors.muted, marginTop: 42 }}>{ogText(market.description || (model ? 'Trade this Hugging Face model market on repo.ing.' : 'Trade this open source repository market on repo.ing.'), 120)}</span>}
    {model && <span style={{ display: 'flex', marginTop: 26, fontSize: 22, color: colors.muted }}>{HF_DISCLAIMER_SHORT}</span>}
  </Frame>
}
