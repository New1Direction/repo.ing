import { WalletIdentity } from './wallet-identity'
import { marketBackers } from '../lib/backers.mjs'
import { xLinksEnabled } from '../lib/x-links.mjs'
import { formatSolDisplay } from '../lib/format.mjs'
import { holdingLabel } from '../lib/holder-note-format.mjs'
import { signedPayoutWallet } from '../lib/official-launch.mjs'

const day = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null

function Backer({ backer, rank, symbol }) {
  const since = day(backer.firstBuyAt)
  return <li className="backer">
    <span className="backer-rank" aria-hidden="true">{rank}</span>
    <div className="backer-who">
      <WalletIdentity wallet={backer.wallet} link={backer.x}/>
      {backer.earlyRank && <span className="backer-early" title={`Among the first buyers of $${symbol} on repo.ing (#${backer.earlyRank})`}>Early backer #{backer.earlyRank}</span>}
    </div>
    <div className="backer-amount"><strong>{holdingLabel(backer.netBaseUnits)} <span>${symbol}</span></strong>
      <small>{formatSolDisplay(backer.spentLamports)} SOL spent{since && <> · since <time dateTime={backer.firstBuyAt}>{since}</time></>}</small></div>
    {backer.note && <p className="backer-note"><span className="sr-only">Their holder note: </span>“{backer.note}”</p>}
  </li>
}

function Disclosed({ rows, symbol, beneficiaryWallet }) {
  if (!rows.length) return null
  return <div className="backers-disclosed"><h4>Labelled wallets <span>(not counted)</span></h4>
    <ul>{rows.map(row => <li key={row.wallet}><span className={`backer-label is-${row.kind}`}>{row.label}</span>
      <WalletIdentity wallet={row.wallet} link={row.x} trust={row.wallet === beneficiaryWallet}/><span className="backer-disclosed-amount">{holdingLabel(row.netBaseUnits)} ${symbol}</span></li>)}</ul></div>
}

// Details → Backers. Server component; shares the per-request read with the hero pill.
export async function Backers({ market }) {
  const data = await marketBackers(market)
  const x = xLinksEnabled()
  const count = data?.count ?? 0
  return <section id="backers" className="inner-card backers-card" aria-labelledby="backers-title">
    <div className="backers-heading"><div><h3 id="backers-title">Backed by</h3>
      <p className="backers-source">Wallets with a net buy of ${market.symbol} from trades on repo.ing</p></div>
      {data && <strong className="backers-count"><span>{count.toLocaleString('en-US')}</span> {count === 1 ? 'backer' : 'backers'}</strong>}</div>
    {!data ? <p className="backers-empty" role="status">Backers are temporarily unavailable.</p>
      : count ? <ol className="backers-list">{data.top.map((backer, index) => <Backer key={backer.wallet} backer={backer} rank={index + 1} symbol={market.symbol}/>)}</ol>
        : <p className="backers-empty">No backers yet. Buy ${market.symbol} here to be the first — the first {data.early} buyers get an <span className="backer-early">Early backer</span> badge.</p>}
    {data && count > data.top.length && <p className="backers-more">+{(count - data.top.length).toLocaleString('en-US')} more {count - data.top.length === 1 ? 'backer' : 'backers'}</p>}
    {data && <Disclosed rows={data.disclosed} symbol={market.symbol} beneficiaryWallet={signedPayoutWallet(market)}/>}
    <div className="backers-foot">
      {x && <a className="backers-cta" href="/wallet#x-account">Link your X to get credited →</a>}
      <p>Net bought = bought − sold through indexed swaps (bonding curve and graduated pool). Transfers are not counted, so this differs from the on-chain Holders count. Only public wallet data and X accounts linked by a wallet signature are shown.</p>
    </div>
  </section>
}

export const BackersFallback = () => <section className="inner-card backers-card" aria-busy="true" aria-labelledby="backers-title">
  <div className="backers-heading"><div><h3 id="backers-title">Backed by</h3><p className="backers-source">Loading backers…</p></div></div>
  <ol className="backers-list" aria-hidden="true">{[0, 1, 2].map(i => <li key={i} className="backer is-placeholder"><span className="skeleton-text"/><span className="skeleton-text"/></li>)}</ol>
</section>

// Hero pill: "Backed by N" linking to the Backers tab. Nothing while there are none or the read fails.
export async function BackersPill({ market, href = '#backers' }) {
  const data = await marketBackers(market)
  if (!data?.count) return null
  return <a className="badge backers-pill" href={href}>Backed by {data.count.toLocaleString('en-US')}</a>
}
