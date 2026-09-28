// Fixed dimensions and server-proven inputs keep exported cards readable and factual.
export function MarketShareArtwork({ market, snapshot }) {
  const muted = '#aeb6c1', green = '#81e6ad'
  return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#101213', color: '#f4f6fa', padding: '48px 56px', fontFamily: 'sans-serif' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 26, borderBottom: '1px solid #32373a' }}><span style={{ fontSize: 34, fontWeight: 700 }}>repo<span style={{ color: green }}>.ing</span></span><span style={{ fontSize: 20, color: muted }}>Open source markets</span></div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 26 }}><span style={{ fontSize: 25, color: muted }}>{market.fullName.slice(0, 70)}</span><span style={{ fontSize: 23, color: green }}>${market.symbol}</span></div>
    <span style={{ fontSize: 28, marginTop: 28 }}>{snapshot.headline}</span>
    <strong style={{ fontSize: snapshot.metric.length > 18 ? 58 : 80, letterSpacing: '-2px', color: green, marginTop: 4 }}>{snapshot.metric}</strong>
    {snapshot.kind === 'graduation' && <div style={{ display: 'flex', width: '100%', height: 12, background: '#282e32', borderRadius: 6, marginTop: 12, marginBottom: 18 }}><div style={{ display: 'flex', width: `${snapshot.percent}%`, background: green, borderRadius: 6 }}/></div>}
    <span style={{ fontSize: 24, marginTop: 8 }}>{snapshot.detail}</span><span style={{ fontSize: 20, color: muted, marginTop: 10 }}>{snapshot.note}</span>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto', paddingTop: 20, borderTop: '1px solid #32373a', color: muted, fontSize: 17 }}><span>{snapshot.kind === 'graduation' ? 'On-chain snapshot' : 'Payout settled'} · {snapshot.timestamp.replace(/\.\d{3}Z$/, ' UTC').replace('T', ' ')}</span><span>Mint: {market.mint}</span></div>
  </div>
}
