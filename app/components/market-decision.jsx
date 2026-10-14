import { maintainerStatus } from '../../src/trust-signals.mjs'
import '../public-launch.css'

// Uses only the market and worker activity already loaded by the page. Never fetches evidence.
export function MarketDecision({ market, pulse, declined, stockPair = false }) {
  const verified = maintainerStatus(market).verified
  return <section className="market-decision" aria-labelledby="market-decision-title">
    <div className="market-decision-heading"><h2 id="market-decision-title">Before you trade</h2>
      <span className="market-decision-status">{declined === undefined ? 'Maintainer status unavailable' : declined ? 'Maintainer declined this market'
        : stockPair ? 'Stock pair · no owner claim' : verified ? 'GitHub admin verified' : 'Maintainer not verified'}</span></div>
    <p><strong>You can lose your entire trade.</strong> A repository token is not equity, ownership of the code, or a right to revenue.
      Verification confirms repository access, not endorsement or investment quality.</p>
    <div className="market-decision-links">
      {!stockPair && <a href="#transparency" data-market-event="evidence">Quality evidence &amp; unknowns →</a>}
      <a href={pulse ? '#dev-pulse' : '#repository'} data-market-event="history">Release &amp; activity history →</a>
      {!stockPair && <a href="#transparency" data-market-event="risks">Liquidity, allocations &amp; risks →</a>}
    </div>
    <p className="market-decision-note">Watch saves interest in this browser only—not a purchase, pledge, public watcher count or measure of demand.
      {!pulse && ' Activity evidence is unavailable here; check the repository before drawing conclusions.'}</p>
    <details><summary data-market-event="risks">Trade risks and measurement disclosure</summary>
      <p>Thin or one-sided liquidity can make selling costly or impossible. Price impact, trading fees and network costs reduce what you receive.
        Review the current quote, minimum received and slippage before signing. Historical depth is not an executable quote; activity is not a promise of future work.</p>
      <p>Anonymous page and action counts help improve this flow. We send no wallet, repository ID, page URL, referrer or persistent identifier.
        Global Privacy Control and Do Not Track disable these events. Counts are not unique people or completed trades.</p>
    </details>
  </section>
}
