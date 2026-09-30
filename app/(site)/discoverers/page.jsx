import Link from 'next/link'
import { AppHeader,Footer } from '../../components/ui'
import { DiscovererTable } from '../../components/growth-surfaces'
import { database } from '../../lib/server.mjs'
import { discovererLeaderboard } from '../../../src/discoverer-growth.mjs'
import { xHandlesFor } from '../../lib/x-links.mjs'
export const dynamic='force-dynamic'
export const metadata={title:'Top Discoverers — repo.ing',description:'Verified launches, discovery fees, and market volume on repo.ing.'}
export default async function Discoverers(){
  let data,error,handles={}
  try{data=await discovererLeaderboard(database())}catch{error='Discoverer activity is temporarily unavailable.'}
  if(data)try{handles=Object.fromEntries(await xHandlesFor(data.leaders.slice(0,100).map(row=>row.wallet)))}catch{handles={}}
  return <><AppHeader active="explore"/><main className="section-wrap operations-page"><div className="growth-heading"><div><h1>Top Discoverers</h1><p>Find a repository early. Help its market get started.</p></div><Link className="button outline" href="/launch">Launch a repository</Link></div>
    <p className="growth-footnote">Ranked by earned discovery fees. Volume counts verified, reward-eligible curve trades; it is not attributed to trades made by the discoverer. Current launches earn 50% of partner curve fees until graduation, 30 days, or a 2.5 SOL cap. Older policies keep their original cap. Launching a market does not establish repository ownership or endorsement.</p>
    {error?<p role="status">{error}</p>:<><DiscovererTable leaders={data.leaders} handles={handles}/>{data.excluded.length>0&&<p className="subtle-notice">Some markets are excluded while attribution is being verified.</p>}<p className="growth-footnote">Finalized indexed evidence · updated {new Date(data.checkedAt).toLocaleString()}</p></>}
  </main><Footer/></>
}
