'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useWallet } from './wallet'
import { CopyAddress } from './copy-address'
import { formatSolDisplay, formatUsdEstimate } from '../lib/format.mjs'
import { chartPriceLabel } from '../lib/chart-display.mjs'
import { sortHoldingsByValue } from '../lib/portfolio.mjs'
import { tokenBalanceLabel } from '../lib/token-balance.mjs'
import { visiblePolling } from '../lib/visible-polling.mjs'
import { xReturnShareUrl } from '../lib/share-links.mjs'
import { XMark } from './x-mark'

export function WalletOverview() {
  const { wallet, connect, restoring } = useWallet()
  const [data, setData] = useState(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [tab, setTab] = useState('Holdings')
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
  const rewards = rows.reduce((total, m) => total + BigInt(m.discovery?.remaining ?? '0'), 0n)
  const filtered = rows.filter(m => tab === 'Holdings' ? BigInt(m.balanceBaseUnits ?? '0') > 0n : tab === 'Launched' ? m.launchedByYou : m.discovery || m.builderWallet)
  const shown = tab === 'Holdings' ? sortHoldingsByValue(filtered) : filtered
  const usdPerSol = current?.usdPerSol, portfolio = current?.portfolio
  const totalUsd = portfolio && formatUsdEstimate(portfolio.valueLamports, usdPerSol)
  return <><div className="wallet-overview-heading"><CopyAddress address={wallet} compact label="wallet address"/><button className="button outline" onClick={() => setRefresh(v => v + 1)}>Refresh</button></div>
    {error && <p role="alert" className="inline-error">{error} {current && 'Values below are from the last successful refresh.'}</p>}
    {!current ? <p role="status">{error ? 'Wallet data unavailable.' : 'Loading balances and rewards…'}</p> : <>
      <div className="wallet-summary">{current.holdingsAvailable && portfolio && <div className="inner-card wallet-portfolio"><span>Portfolio value</span><strong>{current.pricesAvailable ? `${formatSolDisplay(portfolio.valueLamports)} SOL` : '—'}</strong>{current.pricesAvailable && totalUsd && <em>≈ {totalUsd}</em>}<small>{portfolioNote(portfolio, current.pricesAvailable)}</small></div>}<div className="inner-card"><span>SOL balance</span><strong>{formatSolDisplay(current.solBalance)} SOL</strong></div><div className="inner-card"><span>Markets launched</span><strong>{rows.filter(m => m.launchedByYou).length}</strong></div><div className="inner-card"><span>Discovery rewards available</span><strong>{formatSolDisplay(rewards)} SOL</strong><small>Network and account setup costs apply when claiming.</small></div></div>
      <div className="segmented" role="tablist" aria-label="Your markets">{['Holdings', 'Launched', 'Rewards'].map(name => <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? 'selected' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
      {tab === 'Holdings' && !current.holdingsAvailable ? <p role="status" className="state-card">Token balances are temporarily unavailable. Your launches and rewards are still available in their tabs.</p> : shown.length ? <div className="wallet-market-list">{shown.map(m => <article className="inner-card wallet-market" key={m.mint}>
        <Link className="wallet-market-title" href={`/token/${m.mint}`}><img src={`/api/repo-logo/${m.repoId}?v=3&w=128`} alt="" width={44} height={44} loading="lazy" decoding="async"/><div><strong>${m.symbol}</strong><span>{m.fullName}</span></div></Link>
        <div className="wallet-market-values"><span>You hold<strong>{tokenBalanceLabel(m.balanceBaseUnits)} {m.symbol}</strong></span>{BigInt(m.balanceBaseUnits ?? '0') > 0n && <span className="wallet-market-value">Value<strong>{m.valueLamports === null ? '—' : `${formatSolDisplay(m.valueLamports)} SOL`}</strong><small>{m.priceSol === null ? 'Price pending' : `${formatUsdEstimate(m.valueLamports, usdPerSol) ? `≈ ${formatUsdEstimate(m.valueLamports, usdPerSol)} · ` : ''}${chartPriceLabel(m.priceSol)} SOL each`}</small></span>}{m.discovery && <span>Discovery available<strong>{formatSolDisplay(m.discovery.remaining)} SOL</strong><small>{formatSolDisplay(m.discovery.paid)} SOL paid</small></span>}{m.builderWallet && <span>Builder fees available<strong>{formatSolDisplay(m.builderAvailable)} SOL</strong><small>Eligibility is checked when claiming.</small></span>}{m.launchedByYou && !m.discovery && <span className="muted">Launched before discovery rewards</span>}</div>
        {BigInt(m.balanceBaseUnits ?? '0') > 0n && m.pnl && <HoldingPnl pnl={m.pnl} symbol={m.symbol}/>}
        <div className="wallet-market-actions"><Link className="button outline" href={`/token/${m.mint}`}>Trade</Link>{BigInt(m.balanceBaseUnits ?? '0') > 0n && <ShareReturn market={m}/>}{m.discovery && <Link className="button primary" href={`/token/${m.mint}#discovery-heading`}>View rewards</Link>}{m.builderWallet && <Link className="button outline" href={`/claim/${m.repoId}`}>Claim builder fees</Link>}</div>
      </article>)}</div> : <div className="state-card"><h3>{tab === 'Holdings' ? 'No repo.ing tokens in this wallet yet' : tab === 'Launched' ? 'Your launches will appear here' : 'No rewards for this wallet yet'}</h3><p>{tab === 'Rewards' ? 'Launch a new repository market to start earning discovery rewards from eligible trades.' : 'Explore markets or paste a GitHub repository on the homepage to launch one.'}</p><Link className="button outline" href={tab === 'Holdings' ? '/explore' : '/'}>{tab === 'Holdings' ? 'Explore markets' : 'Launch a repository'}</Link></div>}
      <p className="muted wallet-updated">Updated {new Date(current.checkedAt).toLocaleTimeString()} · Shows repo.ing markets only. Values use each market’s latest finalized trade price; USD is an estimate. P&amp;L uses average cost from this wallet’s indexed trades, before network fees.</p>
    </>}</>
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

// Shares only the percentage and the market: no wallet, SOL amounts or position size leave this page.
function ShareReturn({ market }) {
  const href = xReturnShareUrl({ mint: market.mint, symbol: market.symbol, fullName: market.fullName, percent: market.pnl?.unrealizedPercent })
  if (!href) return null
  return <a className="button outline" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Share your return on $${market.symbol} on X`}><XMark size={14}/>Share</a>
}

function portfolioNote({ holdings, unpriced }, pricesAvailable) {
  if (!pricesAvailable) return 'Prices are temporarily unavailable.'
  const count = `${holdings} ${holdings === 1 ? 'holding' : 'holdings'}`
  return unpriced ? `${count} · ${unpriced} awaiting a price, not included` : `${count} at latest trade price`
}
