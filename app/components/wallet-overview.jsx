'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useWallet } from './wallet'
import { CopyAddress } from './copy-address'
import { formatSolDisplay } from '../lib/format.mjs'
import { tokenBalanceLabel } from '../lib/token-balance.mjs'

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
    load(); const timer = setInterval(load, 20000)
    window.addEventListener('repoing:trade-confirmed', load)
    return () => { active = false; controller.abort(); clearInterval(timer); window.removeEventListener('repoing:trade-confirmed', load) }
  }, [wallet, refresh])
  if (!wallet) return <section className="state-card"><h2>{restoring ? 'Reconnecting your wallet…' : 'Connect to see your markets'}</h2><p>View balances and rewards. No signature is needed to view this page.</p><button className="button primary" onClick={() => connect().catch(() => {})}>Connect wallet</button></section>
  const current = data?.wallet === wallet ? data : null
  const rows = current?.markets ?? []
  const rewards = rows.reduce((total, m) => total + BigInt(m.discovery?.remaining ?? '0'), 0n)
  const shown = rows.filter(m => tab === 'Holdings' ? BigInt(m.balanceBaseUnits ?? '0') > 0n : tab === 'Launched' ? m.launchedByYou : m.discovery || m.builderWallet)
  return <><div className="wallet-overview-heading"><CopyAddress address={wallet} compact label="wallet address"/><button className="button outline" onClick={() => setRefresh(v => v + 1)}>Refresh</button></div>
    {error && <p role="alert" className="inline-error">{error} {current && 'Values below are from the last successful refresh.'}</p>}
    {!current ? <p role="status">{error ? 'Wallet data unavailable.' : 'Loading balances and rewards…'}</p> : <>
      <div className="wallet-summary"><div className="inner-card"><span>SOL balance</span><strong>{formatSolDisplay(current.solBalance)} SOL</strong></div><div className="inner-card"><span>Markets launched</span><strong>{rows.filter(m => m.launchedByYou).length}</strong></div><div className="inner-card"><span>Discovery rewards available</span><strong>{formatSolDisplay(rewards)} SOL</strong><small>Network and account setup costs apply when claiming.</small></div></div>
      <div className="segmented" role="tablist" aria-label="Your markets">{['Holdings', 'Launched', 'Rewards'].map(name => <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? 'selected' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
      {tab === 'Holdings' && !current.holdingsAvailable ? <p role="status" className="state-card">Token balances are temporarily unavailable. Your launches and rewards are still available in their tabs.</p> : shown.length ? <div className="wallet-market-list">{shown.map(m => <article className="inner-card wallet-market" key={m.mint}>
        <Link className="wallet-market-title" href={`/token/${m.mint}`}><img src={`/api/repo-logo/${m.repoId}?v=3`} alt=""/><div><strong>${m.symbol}</strong><span>{m.fullName}</span></div></Link>
        <div className="wallet-market-values"><span>You hold<strong>{tokenBalanceLabel(m.balanceBaseUnits)} {m.symbol}</strong></span>{m.discovery && <span>Discovery available<strong>{formatSolDisplay(m.discovery.remaining)} SOL</strong><small>{formatSolDisplay(m.discovery.paid)} SOL paid</small></span>}{m.builderWallet && <span>Builder fees available<strong>{formatSolDisplay(m.builderAvailable)} SOL</strong><small>Eligibility is checked when claiming.</small></span>}{m.launchedByYou && !m.discovery && <span className="muted">Launched before discovery rewards</span>}</div>
        <div className="wallet-market-actions"><Link className="button outline" href={`/token/${m.mint}`}>Trade</Link>{m.discovery && <Link className="button primary" href={`/token/${m.mint}#discovery-heading`}>View rewards</Link>}{m.builderWallet && <Link className="button outline" href={`/claim/${m.repoId}`}>Claim builder fees</Link>}</div>
      </article>)}</div> : <div className="state-card"><h3>{tab === 'Holdings' ? 'No repo.ing tokens in this wallet yet' : tab === 'Launched' ? 'Your launches will appear here' : 'No rewards for this wallet yet'}</h3><p>{tab === 'Rewards' ? 'Launch a new repository market to start earning discovery rewards from eligible trades.' : 'Explore markets or paste a GitHub repository on the homepage to launch one.'}</p><Link className="button outline" href={tab === 'Holdings' ? '/explore' : '/'}>{tab === 'Holdings' ? 'Explore markets' : 'Launch a repository'}</Link></div>}
      <p className="muted wallet-updated">Updated {new Date(current.checkedAt).toLocaleTimeString()} · Shows repo.ing markets only.</p>
    </>}</>
}
