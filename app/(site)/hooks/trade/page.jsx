import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { PublicKey } from '@solana/web3.js'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'
import { HookCoinPreview } from '../../../components/hooklab-coin-form'
import { launchedCoins } from '../../../lib/hooklab-market.mjs'
import { coinImageUrl } from '../../../../src/hooklab-coin-profile.mjs'
import { executionGenesis, localAcceptanceNetwork } from '../../../../src/hooklab-local-acceptance.mjs'
import { HookLocalOperations } from '../../../components/hooklab-local-operations'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Buy & sell Hooks coins — repo.ing', description: 'Buy and sell coins launched with Hooks blocks, with SOL.' }

// Open any Hooks coin by its address (a GET form, so it works without JavaScript).
async function openCoin(formData) {
  'use server'
  const value = String(formData.get('mint') ?? '').trim()
  let mint = null
  try { mint = new PublicKey(value).toBase58() === value ? value : null } catch {}
  redirect(mint ? `/hooks/token/${mint}` : '/hooks/trade?invalid=1')
}

export default async function HooksTradePage({ searchParams }) {
  const coins = await launchedCoins(), invalid = (await searchParams)?.invalid === '1'
  return <><HooksIntro title="Buy & sell." art="discovery-fees" action={<Link className="button primary" href="/hooks/launch-review">Launch a coin <ArrowRight size={16} aria-hidden="true"/></Link>}>
    Trade coins launched with Hooks blocks, with SOL. Pick a coin to see its price, its rules and your balance.
  </HooksIntro><HooksNav active="trade"/>
    {coins.length ? <ul className="hooks-coin-list">{coins.map(coin => <li key={coin.mint}><Link href={`/hooks/token/${coin.mint}`} className="hooks-coin-row">
      <HookCoinPreview image={coin.profile ? coinImageUrl('', coin.id, 128) : null} name={coin.name} symbol={coin.symbol} capBps={coin.capBps} creatorFeeBps={coin.creatorFeeBps} burnBps={coin.burnBps}/>
      <span className="hooks-coin-row-cta">Trade <ArrowRight size={16} aria-hidden="true"/></span></Link></li>)}</ul>
      : <section className="hooks-card hooks-empty"><img src="/hook-icons/max-wallet.webp?v=2" width={72} height={72} alt=""/><h2>No coins yet</h2>
        <p>Coins launched with Hooks blocks show up here as soon as they go live.</p><Link className="button primary" href="/hooks/launch-review">Launch the first one</Link></section>}
    <form action={openCoin} className="hooks-open-coin">
      <label htmlFor="hooks-open-mint">Have a coin address?</label>
      <div><input id="hooks-open-mint" name="mint" className="field-input" placeholder="Paste a Hooks coin address" autoComplete="off" spellCheck={false}/>
        <button type="submit" className="button outline">Open coin</button></div>
      {invalid && <p className="inline-error" role="alert">That isn’t a valid coin address.</p>}
    </form>
    {localAcceptanceNetwork() && <HookLocalOperations genesisHash={executionGenesis()}/>}
    <HooksRisk/></>
}
