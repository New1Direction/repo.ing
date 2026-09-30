import { Suspense } from 'react'
import { AppHeader, Footer } from '../../components/ui'
import { ContentSkeleton } from '../../components/loading-skeleton'
import { PartsHeader, PartsList, PartsReadme } from '../../components/parts-browse'
import { partsBrowseView, partsEnabled, partsLists, partsTabParam } from '../../lib/parts-fund.mjs'
import { xHandlesFor } from '../../lib/x-links.mjs'

export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Parts funds · repo.ing',
  description: 'Browse hardware parts lists from verified open-source maintainers. Back a build in USDC or SOL, all-or-nothing: funded lists pay the builder, missed lists refund every backer.',
  alternates: { canonical: '/parts' },
}

export default async function PartsPage({ searchParams }) {
  const state = partsTabParam((await searchParams)?.state)
  return <><AppHeader active="parts"/><main className="section-wrap parts-browse">
    <PartsHeader/>
    <div className="parts-browse-grid">
      <Suspense key={state} fallback={<ContentSkeleton label="Loading parts lists" rows={3}/>}><Lists state={state}/></Suspense>
      <PartsReadme/>
    </div>
  </main><Footer/></>
}

async function Lists({ state }) {
  const now = Date.now()
  // Parts funds ride on the tip wallet; while they are off, token pages hide their lists, so none are listed here.
  const { rows, unavailable } = partsEnabled() ? await partsLists() : { rows: [], unavailable: null }
  const view = partsBrowseView(rows, state, now)
  // Linked X @handles (wallet-signed) for the listed maintainers and top backers, in one batched read.
  const wallets = [...new Set(view.lists.flatMap(fund => [fund.maintainerWallet, ...fund.backerWallets]).filter(Boolean))]
  let links = new Map()
  try { links = await xHandlesFor(wallets) } catch { links = new Map() }
  return <PartsList view={view} links={links} now={now} notice={unavailable}/>
}
