import { PublicKey } from '@solana/web3.js'
import { discoveryCap, discoveryEarned, DISCOVERY_WINDOW_MS } from './discovery-rewards.mjs'
import { createMarketConfigResolver } from './market-config.mjs'
import { publicGraduation } from './graduation-readiness.mjs'
import { trendOperatorView } from './trend-intake.mjs'
import { publicTrendCandidates } from './public-trends.mjs'

export function discovererAttribution(market,events,claims,trades=events) {
  if(!market.wallet||new PublicKey(market.wallet).toBase58()!==market.wallet||!market.signature||market.finality!=='finalized'||!market.indexedAt)throw Error('DISCOVERER_ATTRIBUTION_MISSING')
  const start=Date.parse(market.launchedAt)
  if(!Number.isFinite(start)||start<=0)throw Error('DISCOVERY_PERIOD_MISMATCH')
  if(market.version===null){
    if(events.length||claims.length)throw Error('DISCOVERY_PERIOD_MISMATCH')
    return {...market,enrolled:false,earned:'0',paid:'0',rewardVolume:'0',expiresAt:null}
  }
  const cap=discoveryCap(market.version),end=start+DISCOVERY_WINDOW_MS
  let partner=0n,volume=0n,volumeComplete=true,cutoff=null
  const ordered=[...events].sort((a,b)=>BigInt(a.slot)<BigInt(b.slot)?-1:BigInt(a.slot)>BigInt(b.slot)?1:a.eventIndex-b.eventIndex)
  for(const event of ordered){
    const time=Date.parse(event.tradedAt)
    if(event.pool!==market.pool||!Number.isFinite(time)||time<start||time>=end||BigInt(event.partnerAmount)<=0n)throw Error('DISCOVERY_PERIOD_MISMATCH')
    if(event.quoteAmount===null||event.quoteAmount===undefined)throw Error('TRADE_EVIDENCE_MISSING')
    if(partner<cap*2n){
      if(partner+BigInt(event.partnerAmount)>=cap*2n)cutoff=event
    }
    partner+=BigInt(event.partnerAmount)
  }
  // Include even tiny trades that round partner fees to zero. Fee-event presence
  // establishes rewards, but does not define the market's entire trading volume.
  const eligible=trades.filter(t=>Date.parse(t.tradedAt)>=start&&Date.parse(t.tradedAt)<end)
  if(cutoff){
    const signatures=new Set(eligible.filter(t=>String(t.slot)===String(cutoff.slot)).map(t=>t.signature??t.tradeSignature))
    if(signatures.size>1)volumeComplete=false
  }
  for(const trade of eligible){
    if(trade.pool!==market.pool||trade.quoteAmount===null||trade.quoteAmount===undefined||BigInt(trade.quoteAmount)<0n)throw Error('TRADE_EVIDENCE_MISSING')
    if(!cutoff||BigInt(trade.slot)<BigInt(cutoff.slot)||BigInt(trade.slot)===BigInt(cutoff.slot)&&trade.eventIndex<=cutoff.eventIndex)volume+=BigInt(trade.quoteAmount)
  }
  const earned=discoveryEarned(partner,market.version)
  let paid=0n
  for(const claim of claims){if(claim.wallet!==market.wallet)throw Error('DISCOVERER_WALLET_MISMATCH');paid+=BigInt(claim.amount)}
  if(paid>earned)throw Error('DISCOVERY_SETTLEMENT_MISMATCH')
  return {...market,enrolled:true,cap:String(cap),earned:String(earned),paid:String(paid),rewardVolume:volumeComplete?String(volume):null,
    expiresAt:new Date(end).toISOString()}
}

export async function discovererLeaderboard(pool,config=process.env.DBC_CONFIG,legacy=process.env.DBC_LEGACY_CONFIGS??''){
  const resolveConfig=createMarketConfigResolver(config,legacy)
  // Four independent reads, issued together (a pool runs them on separate connections).
  const [{rows:markets},{rows:events},{rows:claims},{rows:trades}]=await Promise.all([
    pool.query(`select m.github_repo_id::text as "repoId",r.full_name as "fullName",m.mint,m.pool,
    m.launcher_wallet as wallet,m.launch_signature as signature,m.launch_slot::text as slot,m.launch_finality as finality,
    m.indexed_at as "indexedAt",m.launch_block_time as "launchedAt",m.discovery_version as version,
    exists(select 1 from graduation_events g where g.github_repo_id=m.github_repo_id) as graduated
    from markets m join repositories r using(github_repo_id) where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'`),
    pool.query(`select f.github_repo_id::text as "repoId",f.pool,f.partner_amount::text as "partnerAmount",f.slot::text,
    f.traded_at as "tradedAt",f.event_index as "eventIndex",t.signature as "tradeSignature",
    (case when t.direction='buy' then t.input_base_units else t.output_base_units end) as "quoteAmount"
    from discovery_fee_events f left join trade_events t on t.signature=f.signature and t.event_index=f.event_index and t.pool=f.pool and t.slot=f.slot and t.traded_at=f.traded_at where f.discovery_eligible`),
    pool.query(`select github_repo_id::text as "repoId",wallet,amount::text from discovery_claims where status='settled'`),
    pool.query(`select m.github_repo_id::text as "repoId",t.pool,t.signature,t.slot::text,t.event_index as "eventIndex",t.traded_at as "tradedAt",
    (case when t.direction='buy' then t.input_base_units else t.output_base_units end) as "quoteAmount"
    from trade_events t join markets m on m.pool=t.pool where m.discovery_version in(1,2) and m.indexed_at is not null
    and t.traded_at>=m.launch_block_time and t.traded_at<m.launch_block_time + interval '30 days'`)])
  const byWallet=new Map(),attributions=[],excluded=[]
  for(const market of markets){
    try{
      resolveConfig(market)
      const row=discovererAttribution(market,events.filter(e=>e.repoId===market.repoId),claims.filter(c=>c.repoId===market.repoId),trades.filter(t=>t.repoId===market.repoId))
      attributions.push(row)
      const total=byWallet.get(row.wallet)??{wallet:row.wallet,earned:0n,volume:0n,volumeComplete:true,launched:0,graduated:0,markets:[]}
      total.earned+=BigInt(row.earned);total.volume+=BigInt(row.rewardVolume??0);total.volumeComplete&&=row.rewardVolume!==null
      total.launched++;total.graduated+=row.graduated?1:0;total.markets.push(row)
      byWallet.set(row.wallet,total)
    }catch(error){excluded.push({repoId:market.repoId,code:error.message})}
  }
  const leaders=[...byWallet.values()].sort((a,b)=>a.earned!==b.earned?(a.earned>b.earned?-1:1):a.volume!==b.volume?(a.volume>b.volume?-1:1):b.launched-a.launched||a.wallet.localeCompare(b.wallet))
    .map(row=>({...row,earned:String(row.earned),volume:row.volumeComplete?String(row.volume):null}))
  return {leaders,attributions,excluded,checkedAt:new Date().toISOString()}
}

export async function growthSurface(pool,{operator=false}={}){
  const [trends,discovery,{rows}]=await Promise.all([trendOperatorView(pool),discovererLeaderboard(pool),pool.query(`select m.github_repo_id::text as "repoId",r.full_name as "fullName",m.mint,m.launcher_wallet as wallet,
    m.launch_block_time as "launchedAt",coalesce((select sum(amount_base_units) from builder_fee_credits b where b.github_repo_id=m.github_repo_id),0)::text as earned,
    (coalesce((select sum((case when direction='buy' then input_base_units else output_base_units end)::numeric) from trade_events t where t.pool=m.pool),0)+
      coalesce((select sum(quote_amount) from damm_trade_events d where d.github_repo_id=m.github_repo_id),0))::text as volume,
    o.status,o.observation,o.reconciliation,o.error_code,g.evidence_hash as migration_evidence_hash,
    exists(select 1 from trend_launches l where l.mint=m.mint) as "fromTrend"
    from markets m join repositories r using(github_repo_id) left join graduation_observations o using(github_repo_id)
    left join graduation_events g using(github_repo_id) where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'`)])
  const markets=rows.map(row=>{
    let graduation=null
    try{graduation=publicGraduation(row)}catch{}
    return {repoId:row.repoId,fullName:row.fullName,mint:row.mint,wallet:row.wallet,launchedAt:row.launchedAt,
      earned:row.earned,volume:row.volume,graduation,fromTrend:row.fromTrend}
  })
  const closest=markets.filter(m=>m.graduation?.phase==='CURVE').sort((a,b)=>{
    const d=BigInt(b.graduation.reserveLamports)*BigInt(a.graduation.thresholdLamports)-BigInt(a.graduation.reserveLamports)*BigInt(b.graduation.thresholdLamports)
    return d>0n?1:d<0n?-1:0
  }).slice(0,5)
  return {checkedAt:new Date().toISOString(),
    candidates:operator?trends.candidates:publicTrendCandidates(trends.candidates,{limit:5}),
    leaders:discovery.leaders.slice(0,operator?100:10),leaderboardPartial:discovery.excluded.length>0,
    newMarkets:[...markets].sort((a,b)=>Date.parse(b.launchedAt)-Date.parse(a.launchedAt)).slice(0,5),closest,
    earners:[...markets].sort((a,b)=>BigInt(a.earned)>BigInt(b.earned)?-1:BigInt(a.earned)<BigInt(b.earned)?1:0).slice(0,5),
    ...(operator?{sources:trends.sources,recentTrends:markets.filter(m=>m.fromTrend).sort((a,b)=>Date.parse(b.launchedAt)-Date.parse(a.launchedAt)),attributionReview:discovery.excluded}:{})}
}
