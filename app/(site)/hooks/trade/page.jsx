import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { PublicKey } from '@solana/web3.js'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'
import { ContentSkeleton } from '../../../components/loading-skeleton'
import { HookCoinExplore } from '../../../components/hooks-explore'
import { exploreHookCoins, hookCoinRow } from '../../../lib/hooklab-explore.mjs'
import { solUsdPrice } from '../../../lib/sol-usd.mjs'
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
  const [coins, usdPerSol] = await Promise.all([exploreHookCoins(), solUsdPrice()]), invalid = (await searchParams)?.invalid === '1'
  return <><HooksIntro title="Buy & sell." art="discovery-fees" action={<Link className="button primary" href="/hooks/launch-review">Launch a coin <ArrowRight size={16} aria-hidden="true"/></Link>}>
    Trade coins launched with Hooks blocks, with SOL. Pick a coin to see its price, its rules and your balance.
  </HooksIntro><HooksNav active="trade"/>
    {coins.length ? <Suspense fallback={<ContentSkeleton label="Loading Hooks coins"/>}><HookCoinExplore coins={coins.map(hookCoinRow)} usdPerSol={usdPerSol} basePath="/hooks/trade"/></Suspense>
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
