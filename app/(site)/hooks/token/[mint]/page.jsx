import Link from 'next/link'
import { PublicKey } from '@solana/web3.js'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { HooksRisk } from '../../../../components/hooks-ui'
import { HookCoinPreview } from '../../../../components/hooklab-coin-form'
import { HookTradePanel } from '../../../../components/hooklab-trade-panel'
import { inclusiveTradeRuntime } from '../../../../lib/hooklab-inclusive-trade-runtime.mjs'
import { cachedMarket, launchedCoinProfile } from '../../../../lib/hooklab-market.mjs'
import { coinImageUrl } from '../../../../../src/hooklab-coin-profile.mjs'
import { hookBlock } from '../../../../../src/hooklab-blocks.mjs'
import { executionGenesis } from '../../../../../src/hooklab-local-acceptance.mjs'
import { formatUnits } from '../../../../lib/hooklab-trade-math.mjs'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Hooks coin — repo.ing', robots: { index: false } }
const short = address => `${address.slice(0, 4)}…${address.slice(-4)}`

async function load(mint) {
  const runtime = inclusiveTradeRuntime()
  if (!runtime?.market) return { unavailable: true }
  try {
    const view = await cachedMarket(runtime, mint)
    return view ? { view, coin: await launchedCoinProfile(mint) } : { missing: true }
  } catch { return { unavailable: true } }
}

export default async function HooksCoinPage({ params }) {
  const { mint } = await params
  try { if (new PublicKey(mint).toBase58() !== mint) notFound() } catch { notFound() }
  const { view, coin, missing, unavailable } = await load(mint)
  if (missing) notFound()
  const market = view?.market
  return <><Link className="back-link" href="/hooks/trade"><ArrowLeft size={16} aria-hidden="true"/> Buy &amp; sell</Link>
    {unavailable || !market ? <section className="hooks-card hooks-empty"><img src="/launch-icons/find-repo.webp" width={72} height={72} alt=""/>
      <h1 className="hooks-coin-title">Coin details are loading slowly</h1><p>We couldn’t read this coin from Solana just now. Refresh in a moment.</p></section>
      : <div className="hooks-coin-layout">
        <div className="hooks-coin-main">
          <section className="hooks-card hooks-coin-hero" aria-labelledby="hooks-coin-name">
            <HookCoinPreview image={coin?.profile ? coinImageUrl('', coin.id, 256) : null} name={market.name} symbol={market.symbol}
              capBps={market.capBps} creatorFeeBps={market.creatorFeeBps} profile={coin?.profile ?? null}/>
            <h1 id="hooks-coin-name" className="sr-only">{market.name} (${market.symbol})</h1>
            {coin?.profile?.description && <p className="hooks-coin-about">{coin.profile.description}</p>}
            <dl className="hooks-coin-stats">
              <div><dt>Market cap</dt><dd>{formatUnits(BigInt(market.marketCapLamports), 9, 3)} SOL</dd></div>
              <div><dt>Trades</dt><dd>{Number(market.pool.swapCount).toLocaleString('en-US')}</dd></div>
              <div><dt>Creator</dt><dd><a href={`https://explorer.solana.com/address/${market.creator}`} target="_blank" rel="noopener noreferrer">{short(market.creator)}</a></dd></div>
            </dl>
            <div className="hooks-curve" aria-label="Progress to graduation">
              <div className="hooks-between"><span>Bonding curve</span><strong>{(market.curveProgressBps / 100).toFixed(1)}% to graduation</strong></div>
              <div className="hooks-curve-bar"><span style={{ transform: `scaleX(${Math.min(1, market.curveProgressBps / 10000)})` }}/></div>
              <small>Graduates when {formatUnits(BigInt(market.graduationQuote), 9, 2)} SOL is in the curve. Until then, wallet caps apply.</small>
            </div>
          </section>
          <section className="hooks-card" aria-labelledby="hooks-coin-blocks">
            <h2 id="hooks-coin-blocks">Blocks on this coin</h2>
            <ul className="hooks-block-grid hooks-coin-blocks">
              {[['max-wallet', `No wallet can hold more than ${market.capBps / 100}% of the supply (${formatUnits(BigInt(market.capRaw), market.decimals, 0)} ${market.symbol}) until graduation.`],
                ['creator-fee', `Every buy and sell pays ${market.creatorFeeBps / 100}%: 75% to the creator, 25% to repo.ing, in SOL.`]].map(([id, text]) =>
                <li key={id} className="hooks-block is-on"><header><img src={hookBlock(id).icon} width={40} height={40} alt=""/><div><strong>{hookBlock(id).title}</strong><span>{text}</span></div></header></li>)}
            </ul>
          </section>
          <p className="hooks-address">Coin address <code>{mint}</code></p>
        </div>
        <aside className="hooks-coin-side"><HookTradePanel mint={mint} genesisHash={executionGenesis()} initial={view}/></aside>
      </div>}
    <HooksRisk/>
  </>
}
