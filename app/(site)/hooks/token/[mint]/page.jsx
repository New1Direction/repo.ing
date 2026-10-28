import Link from 'next/link'
import { PublicKey } from '@solana/web3.js'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { HooksRisk } from '../../../../components/hooks-ui'
import { HookCoinPreview } from '../../../../components/hooklab-coin-form'
import { HookTradePanel } from '../../../../components/hooklab-trade-panel'
import { HookCoinGraduation } from '../../../../components/hooklab-coin-graduation'
import { HookCoinChart } from '../../../../components/hooklab-coin-chart'
import { HookCoinActivity } from '../../../../components/hooklab-coin-activity'
import { HookClaimFees } from '../../../../components/hooklab-claim-fees'
import { HookBurnCounter, HookFeeHeadline } from '../../../../components/hooklab-trade-ux'
import { HookTypeBadges } from '../../../../components/hooks-badges'
import { inclusiveTradeRuntime } from '../../../../lib/hooklab-inclusive-trade-runtime.mjs'
import { cachedMarket, listedCoin } from '../../../../lib/hooklab-market.mjs'
import { coinImageUrl } from '../../../../../src/hooklab-coin-profile.mjs'
import { hookBlock } from '../../../../../src/hooklab-blocks.mjs'
import { executionGenesis } from '../../../../../src/hooklab-local-acceptance.mjs'
import { formatUnits, tradesFromWallet } from '../../../../lib/hooklab-trade-math.mjs'
import { cachedSolUsdPrice } from '../../../../lib/sol-usd.mjs'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Hooks coin — repo.ing', robots: { index: false } }
const short = address => `${address.slice(0, 4)}…${address.slice(-4)}`

async function load(mint) {
  const runtime = inclusiveTradeRuntime()
  if (!runtime?.market || !runtime.coinProfile) return { unavailable: true }
  try {
    // Only coins launched through repo.ing are shown.
    const coin = await listedCoin(runtime, mint)
    if (!coin) return { missing: true }
    // The coin's record picks its stack (ours or the legacy one) for the market read.
    const view = await cachedMarket(runtime, mint, null, coin)
    return view ? { view, coin } : { missing: true }
  } catch { return { unavailable: true } }
}

export default async function HooksCoinPage({ params }) {
  const { mint } = await params
  try { if (new PublicKey(mint).toBase58() !== mint) notFound() } catch { notFound() }
  const { view, coin, missing, unavailable } = await load(mint)
  if (missing) notFound()
  const market = view?.market
  // Every coin shown here launched through repo.ing, so once its market reads it gets the chart and the Trades and Holders
  // tabs; its swaps are indexed (app/lib/hooklab-coin-activity.mjs).
  const activity = Boolean(market && coin)
  // One grid in reading order (coin, buy and sell, chart, trades and holders, Blocks): phones stack it so the trade panel
  // follows the coin, and desktop keeps the panel in a sticky right column. The panel renders even when coin data is
  // slow, so a visitor can always connect a wallet.
  return <><Link className="back-link" href="/hooks/trade"><ArrowLeft size={16} aria-hidden="true"/> Buy &amp; sell</Link>
    <div className={`hooks-coin-layout${activity ? ' has-activity' : ''}`}>
      {unavailable || !market ? <section className="hooks-card hooks-empty hooks-coin-hero"><img src="/launch-icons/find-repo.webp" width={72} height={72} alt=""/>
        <h1 className="hooks-coin-title">Coin details are loading slowly</h1><p>We couldn’t read this coin from Solana just now. Refresh in a moment.</p></section>
        : <section className="hooks-card hooks-coin-hero" aria-labelledby="hooks-coin-name">
          <HookCoinPreview image={coin?.profile ? coinImageUrl('', coin.id, 256) : null} name={market.name} symbol={market.symbol}
            capBps={market.capBps} creatorFeeBps={market.creatorFeeBps} burnBps={market.burnBuyBps ?? coin?.rules?.burnBuyBps ?? 0} selectedHook={market.selectedHook} profile={coin?.profile ?? null} capLifted={market.graduated}/>
          {/* One fee number with its plain breakdown, and a badge per hook the coin carries (owner UI pass 2026-10-28). */}
          {market.policyKind !== 'selected-hook' && <HookFeeHeadline market={market}/>}
          {market.policyKind !== 'selected-hook' && <HookTypeBadges coin={{ capBps: market.graduated ? 0 : market.capBps, burnBps: market.burnBuyBps ?? 0, creatorFeeBps: market.creatorFeeBps, holderBps: market.holderBps ?? 0 }}/>}
          <h1 id="hooks-coin-name" className="sr-only">{market.name} (${market.symbol})</h1>
          {coin?.moderation?.delisted && <p className="hooks-delisted-notice" role="status">{coin.moderation.notice}</p>}
          {coin?.profile?.description && <p className="hooks-coin-about">{coin.profile.description}</p>}
          <dl className="hooks-coin-stats">
            <div><dt>Market cap</dt><dd>{formatUnits(BigInt(market.marketCapLamports), 9, 3)} SOL</dd></div>
            <div><dt>Trades</dt><dd>{Number(market.pool.swapCount).toLocaleString('en-US')}</dd></div>
            <div><dt>Creator</dt><dd><a href={`https://explorer.solana.com/address/${market.creator}`} target="_blank" rel="noopener noreferrer">{short(market.creator)}</a></dd></div>
          </dl>
          {Number(market.burnBuyBps ?? 0) > 0 && <HookBurnCounter mint={mint} symbol={market.symbol} decimals={market.decimals} initial={{ initialSupply: market.initialSupply, supply: market.supply }}/>}
          <HookCoinGraduation market={market}/>
          {/* Native-SOL coins: their creator claims the fees in SOL here (shown to the creator only). */}
          {process.env.HOOK_NATIVE_LAUNCHES_ENABLED === 'true' && <HookClaimFees mint={mint} symbol={market.symbol} genesisHash={executionGenesis()}/>}
        </section>}
      <aside className="hooks-coin-side"><HookTradePanel mint={mint} genesisHash={executionGenesis()} initial={view ? { ...view, coin } : null}/></aside>
      {/* The chart values the mint's current supply (graduation burns some), the same figure as the card's market cap. */}
      {activity && <div className="hooks-coin-chart"><HookCoinChart mint={mint} symbol={market.symbol} decimals={market.decimals} supply={market.supply ?? market.initialSupply} solUsd={cachedSolUsdPrice()}/></div>}
      {activity && <div className="hooks-coin-activity"><HookCoinActivity mint={mint} symbol={market.symbol} decimals={market.decimals}/></div>}
      {market && <section className="hooks-card hooks-coin-blocks-card" aria-labelledby="hooks-coin-blocks">
        <h2 id="hooks-coin-blocks">Blocks on this coin</h2>
        <ul className="hooks-block-grid hooks-coin-blocks">
          {[market.policyKind === 'selected-hook'
            ? ['selected-hook', 'The selected hook remains active before and after graduation. Hook fees are checked on your transaction before wallet approval. There is no maximum holding per wallet.']
            : ['max-wallet', market.graduated ? 'Lifted at graduation. Any wallet can hold any amount now.'
              : `No wallet can hold more than ${market.capBps / 100}% of the supply (${formatUnits(BigInt(market.capRaw), market.decimals, 0)} ${market.symbol}) until graduation.`],
            ['creator-fee', market.feeModel === 1
              ? `The gross creator fee is ${market.creatorFeeBps / 100}%. repo.ing receives floor(gross / 4); the creator receives the remainder before any configured author share. Custom SOL cuts join the same gross quote fee budget. No additional protocol charge is added to that budget. Hook deductions are measured before each exact trade approval.`
              : `Every buy and sell pays ${market.creatorFeeBps / 100}%: 75% to the creator, 25% to repo.ing, in SOL.`]].map(([id, text]) =>
            <li key={id} className="hooks-block is-on"><header><img src={id === 'selected-hook' ? '/hook-icons/plain.webp?v=2' : hookBlock(id).icon} width={40} height={40} alt=""/><div><strong>{id === 'selected-hook' ? 'Selected hook' : hookBlock(id).title}</strong><span style={{overflowWrap:'anywhere'}}>{text}</span></div></header>
              {id === 'selected-hook' && <details><summary>Technical details</summary><p style={{overflowWrap:'anywhere'}}>Program: {market.selectedHook.program} · Flags: {market.selectedHook.flags}</p></details>}</li>)}
        </ul>
      </section>}
      <p className="hooks-address">Coin address <code>{mint}</code></p>
    </div>
    <HooksRisk native={tradesFromWallet({ market, coin })}/>
  </>
}
