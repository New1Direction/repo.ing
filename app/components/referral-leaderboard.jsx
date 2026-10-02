import { formatSolDisplay } from '../lib/format.mjs'

// Server-rendered: wallets arrive already truncated (src/referral-leaderboard.mjs), never whole.
function Board({ id, title, rows }) {
  return <section className="inner-card referral-board" aria-labelledby={id}>
    <h3 id={id}>{title}</h3>
    {rows.length ? <div className="referral-board-scroll"><table>
      <thead><tr><th scope="col">#</th><th scope="col">Referrer</th><th scope="col">Trades</th><th scope="col">Est. earned</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={`${index}-${row.wallet}`}>
        <td>{index + 1}</td><td><code>{row.wallet}</code></td><td>{row.trades.toLocaleString('en-US')}</td>
        <td>{formatSolDisplay(row.estimatedLamports)} SOL</td></tr>)}</tbody>
    </table></div> : <p className="referral-board-empty">No referred trades yet. Share a market to take the first spot.</p>}
  </section>
}

export function ReferralLeaderboard({ board }) {
  return <div className="referral-boards">
    <Board id="referrers-week" title="Last 7 days" rows={board.week}/>
    <Board id="referrers-all" title="All time" rows={board.allTime}/>
  </div>
}

export function ReferralLeaderboardFallback() {
  return <div className="referral-boards" aria-busy="true">
    {['Last 7 days', 'All time'].map(title => <section key={title} className="inner-card referral-board"><h3>{title}</h3>
      <p className="referral-board-empty" role="status">Loading the leaderboard…</p></section>)}
  </div>
}
