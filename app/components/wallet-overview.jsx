'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useWallet } from './wallet'
import { CopyAddress } from './copy-address'
import { formatSolDisplay, formatUnits, formatUsdEstimate } from '../lib/format.mjs'
import { chartPriceLabel } from '../lib/chart-display.mjs'
import { sortHoldingsByValue } from '../lib/portfolio.mjs'
import { tokenBalanceLabel } from '../lib/token-balance.mjs'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { xReturnShareUrl } from '../lib/share-links.mjs'
import { XMark } from './x-mark'
import { IconArt } from './icon-art'
import { useReferralPayouts } from './refer-link'
import { VerificationBonusWalletValue } from './verification-bonus-status'
import { isModelMarket } from '../lib/hf-model-display.mjs'
import { StockLauncherTile, StockLauncherValue } from './stock-launcher-wallet'

export function WalletOverview() {
  const { wallet, connect, restoring, provider } = useWallet()
  const [data, setData] = useState(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [tab, setTab] = useState('Holdings')
  const tabsRef = useRef(null)
  useEffect(() => {
    setData(null); setError('')
    if (!wallet) return
    let active = true, running = false
    const controller = new AbortController()
    async function load() {
      if (running) return
      running = true
      try {
        const response = await fetch(`/api/wallet/overview?wallet=${wallet}`, { cache: 'no-store', signal: controller.signal })
        const next = await response.json()
        if (!response.ok) throw Error(next.error)
        if (active) { setData(next); setError('') }
      } catch { if (active) setError('Could not refresh your wallet. Please retry.') }
      finally { running = false }
    }
    const stopPolling = visiblePolling(load, 20000)
    window.addEventListener('repoing:trade-confirmed', load)
    return () => { active = false; controller.abort(); stopPolling(); window.removeEventListener('repoing:trade-confirmed', load) }
  }, [wallet, refresh])
  if (!wallet) return <section className="state-card"><h2>{restoring ? 'Reconnecting your wallet…' : 'Connect to see your markets'}</h2><p>View balances and rewards. No signature is needed to view this page.</p><button className="button primary" onClick={() => connect().catch(() => {})}>Connect wallet</button></section>
  const current = data?.wallet === wallet ? data : null
  const rows = current?.markets ?? []
  const filtered = rows.filter(m => tab === 'Holdings' ? BigInt(m.balanceBaseUnits ?? '0') > 0n : tab === 'Launched' ? m.launchedByYou : m.discovery || m.builderWallet || m.verificationBonus || m.stockLauncher)
  const shown = tab === 'Holdings' ? sortHoldingsByValue(filtered) : tab === 'Rewards' ? byClaimable(filtered) : filtered
  const usdPerSol = current?.usdPerSol, portfolio = current?.portfolio
  const totalUsd = portfolio && formatUsdEstimate(portfolio.valueLamports, usdPerSol)
  return <><div className="wallet-overview-heading"><CopyAddress address={wallet} compact label="wallet address"/><button className="button outline" onClick={() => setRefresh(v => v + 1)}>Refresh</button></div>
    {error && <p role="alert" className="inline-error">{error} {current && 'Values below are from the last successful refresh.'}</p>}
    {!current ? <p role="status">{error ? 'Wallet data unavailable.' : 'Loading balances and rewards…'}</p> : <>
      <div className="wallet-summary">{current.holdingsAvailable && portfolio && <div className="inner-card wallet-portfolio"><span>Portfolio value</span><strong>{current.pricesAvailable ? `${formatSolDisplay(portfolio.valueLamports)} SOL` : '—'}</strong>{current.pricesAvailable && totalUsd && <em>≈ {totalUsd}</em>}<small>{portfolioNote(portfolio, current.pricesAvailable)}</small></div>}<div className="inner-card"><span>SOL balance</span><strong>{formatSolDisplay(current.solBalance)} SOL</strong></div><div className="inner-card"><span>Markets launched</span><strong>{rows.filter(m => m.launchedByYou).length}</strong></div><LauncherRewards totals={current.launcherRewards} claimable={rows.filter(m => BigInt(m.discovery?.remaining ?? '0') > 0n)} onShowAll={() => {
        // The tabs sit below the fold on phones: switch and bring the claim list into view.
        setTab('Rewards'); requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      }}/><StockLauncherTile stockLauncher={current.stockLauncher}/></div>
      <ReferralEarnings wallet={wallet} provider={provider}/>
      <div className="segmented" role="tablist" aria-label="Your markets" ref={tabsRef}>{['Holdings', 'Launched', 'Rewards'].map(name => <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? 'selected' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
      {tab === 'Holdings' && !current.holdingsAvailable ? <p role="status" className="state-card">Token balances are temporarily unavailable. Your launches and rewards are still available in their tabs.</p> : shown.length ? <div className="wallet-market-list">{shown.map(m => <article className="inner-card wallet-market" key={m.mint}>
        <Link className="wallet-market-title" href={`/token/${m.mint}`}><img src={`/api/repo-logo/${m.repoId}?v=3&w=128`} alt="" width={44} height={44} loading="lazy" decoding="async"/><div><strong>${m.symbol}</strong><span>{m.fullName}</span></div></Link>
        <div className="wallet-market-values"><span>You hold<strong>{tokenBalanceLabel(m.balanceBaseUnits)} {m.symbol}</strong></span>{BigInt(m.balanceBaseUnits ?? '0') > 0n && <span className="wallet-market-value">Value<strong>{m.valueLamports === null ? '—' : `${formatSolDisplay(m.valueLamports)} SOL`}</strong><small>{m.priceSol === null ? 'Price pending' : `${formatUsdEstimate(m.valueLamports, usdPerSol) ? `≈ ${formatUsdEstimate(m.valueLamports, usdPerSol)} · ` : ''}${chartPriceLabel(m.priceSol)} SOL each`}</small></span>}{m.discovery && <span className={BigInt(m.discovery.remaining) > 0n ? 'wallet-launcher-claimable' : ''}>{BigInt(m.discovery.remaining) > 0n ? 'You earned as launcher' : 'Launcher rewards'}<strong>{formatSolDisplay(m.discovery.remaining)} SOL to claim</strong><small>{formatSolDisplay(m.discovery.earned)} SOL earned · {formatSolDisplay(m.discovery.paid)} SOL paid</small></span>}{m.verificationBonus && <VerificationBonusWalletValue bonus={m.verificationBonus}/>}{m.builderWallet && <span>Builder fees available<strong>{formatSolDisplay(m.builderAvailable)} SOL</strong><small>Eligibility is checked when claiming.</small></span>}{m.stockPair && m.launchedByYou && <StockLauncherValue earnings={m.stockLauncher}/>}{m.launchedByYou && !m.discovery && !m.verificationBonus && !m.stockPair && <span className="muted">Launched before discovery rewards</span>}</div>
        {BigInt(m.balanceBaseUnits ?? '0') > 0n && m.pnl && <HoldingPnl pnl={m.pnl} symbol={m.symbol}/>}
        <div className="wallet-market-actions"><Link className="button outline" href={`/token/${m.mint}`}>Trade</Link>{BigInt(m.balanceBaseUnits ?? '0') > 0n && <ShareReturn market={m}/>}{m.discovery && <Link className={BigInt(m.discovery.remaining) > 0n ? 'button primary' : 'button outline'} href={`/token/${m.mint}#rewards`}>{BigInt(m.discovery.remaining) > 0n ? `Claim ${formatSolDisplay(m.discovery.remaining)} SOL` : 'View rewards'}</Link>}{!m.discovery && m.verificationBonus && <Link className="button outline" href={`/token/${m.mint}#rewards`}>View bonus</Link>}{m.builderWallet && <Link className="button outline" href={`/claim/${m.repoId}`}>Claim builder fees</Link>}{m.stockPair && m.launchedByYou && <Link className="button outline" href={`/token/${m.mint}#fee-routing`}>Fee routing</Link>}</div>
      </article>)}</div> : <div className="state-card has-art"><IconArt name={EMPTY_ART[tab]} size={112}/><div><h3>{tab === 'Holdings' ? 'No repo.ing tokens in this wallet yet' : tab === 'Launched' ? 'Your launches will appear here' : 'No rewards for this wallet yet'}</h3><p>{tab === 'Rewards' ? 'Launch a new repository market to start earning discovery rewards from eligible trades.' : 'Explore markets or paste a GitHub repository on the homepage to launch one.'}</p><Link className="button outline" href={tab === 'Holdings' ? '/explore' : '/'}>{tab === 'Holdings' ? 'Explore markets' : 'Launch a repository'}</Link></div></div>}
      <p className="muted wallet-updated">Updated {new Date(current.checkedAt).toLocaleTimeString()} · Shows repo.ing markets only. Values use each market’s latest finalized trade price; USD is an estimate. P&amp;L uses average cost from this wallet’s indexed trades, before network fees.</p>
    </>}</>
}

// Launcher (discovery) rewards across every market this wallet launched. Claims stay per market on each
// token page, where the launcher wallet signs a claim message; this tile totals them and opens the claim: the token page's
// rewards tab for one market, or the Rewards list (one Claim button per market) for several.
function LauncherRewards({ totals, claimable: markets, onShowAll }) {
  if (!totals) return <div className="inner-card"><span>Launcher rewards</span><strong>—</strong><small>Temporarily unavailable.</small></div>
  const claimable = BigInt(totals.claimable) > 0n
  return <div className={`inner-card wallet-launcher${claimable ? ' is-claimable' : ''}`}><span>Launcher rewards to claim</span>
    <strong>{formatSolDisplay(totals.claimable)} SOL</strong>
    <small>{totals.markets ? `${formatSolDisplay(totals.earned)} SOL earned · ${formatSolDisplay(totals.paid)} SOL paid · ${totals.markets} ${totals.markets === 1 ? 'market' : 'markets'}` : 'Launch a repository to earn 50% of repo.ing’s partner trading fees on it until graduation.'}</small>
    {claimable && (markets.length === 1
      ? <Link className="button primary" href={`/token/${markets[0].mint}#rewards`}>Claim now</Link>
      : <button type="button" className="button primary" onClick={onShowAll}>Claim from {totals.claimableMarkets} markets</button>)}</div>
}

// Decorative art for each tab's empty state; the heading beside it says what is missing.
const EMPTY_ART = { Holdings: 'repo-coin-01', Launched: 'rocket', Rewards: 'earnings-wallet' }

const byClaimable = rows => [...rows].sort((a, b) => {
  const x = BigInt(a.discovery?.remaining ?? '0'), y = BigInt(b.discovery?.remaining ?? '0')
  return x === y ? 0 : x > y ? -1 : 1
})

// Referral payouts accrue as wrapped SOL in this wallet's WSOL account; reads the same status as token pages.
function ReferralEarnings({ wallet, provider }) {
  const { status, setup, enable } = useReferralPayouts(wallet, provider)
  const note = setup && setup !== 'busy' ? setup : status === false ? 'Referral status is temporarily unavailable.' : status?.enabled
    ? 'Held as wrapped SOL in your wallet. Trading on repo.ing unwraps it to SOL.'
    : 'Earn 4% of the trading fee on trades from your referral link. Copy it from any token page.'
  const state = status === null ? 'Checking payouts…' : status === false ? 'Status unavailable' : status.enabled ? 'Payouts enabled' : 'Payouts not enabled'
  return <section className="inner-card wallet-referral" aria-label="Referral earnings" aria-busy={status === null}>
    <div><span>Referral earnings</span><strong>{status ? `${formatSolDisplay(status.earningsLamports)} SOL` : '—'}</strong></div>
    <p><em className={status?.enabled ? 'is-on' : ''}>{state}</em><small role="status">{note}</small></p>
    {status && !status.enabled && <button className="button outline" type="button" onClick={enable} disabled={setup === 'busy'}>{setup === 'busy' ? 'Enabling…' : `Enable payouts (~${formatUnits(status.setupLamports, 9, 5)} SOL, refundable)`}</button>}
  </section>
}

const signed = lamports => `${BigInt(lamports) > 0n ? '+' : ''}${formatSolDisplay(lamports)} SOL`
const tone = lamports => lamports === null ? '' : BigInt(lamports) > 0n ? 'gain' : BigInt(lamports) < 0n ? 'loss' : ''

// Average cost from this wallet's indexed buys and sells here; network fees are not included.
function HoldingPnl({ pnl, symbol }) {
  const percent = pnl.unrealizedPercent === null ? '' : ` (${pnl.unrealizedPercent > 0 ? '+' : ''}${pnl.unrealizedPercent.toFixed(2)}%)`
  return <dl className="wallet-market-pnl" aria-label="Profit and loss">
    <div><dt>Cost basis</dt><dd>{formatSolDisplay(pnl.costBasisLamports)} SOL</dd></div>
    <div><dt>Unrealized P&amp;L</dt><dd className={tone(pnl.unrealizedLamports)}>{pnl.unrealizedLamports === null ? 'Price pending' : `${signed(pnl.unrealizedLamports)}${percent}`}</dd></div>
    <div><dt>Realized P&amp;L</dt><dd className={tone(pnl.realizedLamports)}>{signed(pnl.realizedLamports)}</dd></div>
    {pnl.partial && <p>Partial cost data{BigInt(pnl.uncoveredBaseUnits) > 0n ? ` · ${tokenBalanceLabel(pnl.uncoveredBaseUnits)} ${symbol} have no indexed buy and are excluded` : ' · some sold tokens had no indexed buy and are excluded'}.</p>}
  </dl>
}

// Shares only the percentage and the market: no wallet, SOL amounts or position size leave this page. A Hugging Face model
// market's post carries the disclaimer (share-links.mjs).
function ShareReturn({ market }) {
  const href = xReturnShareUrl({ mint: market.mint, symbol: market.symbol, fullName: market.fullName, percent: market.pnl?.unrealizedPercent,
    source: isModelMarket(market) ? 'huggingface' : 'github' })
  if (!href) return null
  return <a className="button outline" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Share your return on $${market.symbol} on X`}><XMark size={14}/>Share</a>
}

function portfolioNote({ holdings, unpriced }, pricesAvailable) {
  if (!pricesAvailable) return 'Prices are temporarily unavailable.'
  const count = `${holdings} ${holdings === 1 ? 'holding' : 'holdings'}`
  return unpriced ? `${count} · ${unpriced} awaiting a price, not included` : `${count} at latest trade price`
}
