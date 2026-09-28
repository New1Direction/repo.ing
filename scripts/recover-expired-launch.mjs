import { Connection, PublicKey } from '@solana/web3.js'
import { database } from '../app/lib/server.mjs'
import { createMarketConfigResolver } from '../src/market-config.mjs'
import { assertExpiredUnlandedLaunch } from '../src/launch-expiry.mjs'
const repoId = process.argv.find(x => /^--repo=\d+$/.test(x))?.split('=')[1]
if (!repoId) throw Error('Use --repo=<GitHub ID> [--apply]')
const apply = process.argv.includes('--apply')
const urls = [process.env.SOLANA_RPC_URL, process.env.GRADUATION_VERIFICATION_RPC_URL]
if (urls.some(x => !x) || urls[0] === urls[1]) throw Error('Two independent RPC providers required')
const connections = urls.map(url => new Connection(url, {commitment:'finalized',disableRetryOnRateLimit:true,
  fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(15000)})}))
const pool = database(), db = await pool.connect()
try {
  await db.query('select pg_advisory_lock($1::bigint)',[repoId])
  const market = (await db.query('select id,github_repo_id::text,status,mint,pool,launcher_wallet,creator_wallet,launch_signature,blockhash,last_valid_block_height::text,launch_slot::text,indexed_at from markets where github_repo_id=$1',[repoId])).rows[0]
  if (!market) throw Error('Market not found')
  createMarketConfigResolver(process.env.DBC_CONFIG)({ mint:market.mint,pool:market.pool })
  const observations = await Promise.all(connections.map(async c=>{
    const [genesis,height,valid,signatures,transaction,accounts]=await Promise.all([
      c.getGenesisHash(),c.getBlockHeight('finalized'),c.isBlockhashValid(market.blockhash,{commitment:'finalized'}),
      c.getSignatureStatuses([market.launch_signature],{searchTransactionHistory:true}),
      c.getTransaction(market.launch_signature,{commitment:'finalized',maxSupportedTransactionVersion:0}),
      c.getMultipleAccountsInfoAndContext([new PublicKey(market.mint),new PublicKey(market.pool)],{commitment:'finalized'}),
    ])
    return {getGenesisHash:genesis,getBlockHeight:height,isBlockhashValid:valid,getSignatureStatuses:signatures,getTransaction:transaction,
      getMultipleAccounts:{context:accounts.context,value:accounts.value.map(a=>a?{exists:true}:null)}}
  }))
  const evidence = {independentRpc:true,checkedAt:new Date().toISOString(),observations}
  const proof=assertExpiredUnlandedLaunch(market,evidence)
  if(apply){
    await db.query('begin')
    try {
      await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,'LAUNCH_EXPIRED',$3) on conflict(event_key) do nothing`,
        [`launch-expired:${market.launch_signature}`,repoId,JSON.stringify({code:'EXPIRED_UNLANDED',market,evidence,...proof,reviewedBy:'operator-cli'})])
      const result=await db.query(`update markets set status='failed' where id=$1 and status=$2 and launch_signature=$3 and indexed_at is null`,[market.id,market.status,market.launch_signature])
      if(result.rowCount!==1)throw Error('Launch state changed during review')
      await db.query('commit')
    }catch(e){await db.query('rollback');throw e}
  }
  console.log(JSON.stringify({repoId,...proof,applied:apply,broadcast:false}))
} finally { await db.query('select pg_advisory_unlock($1::bigint)',[repoId]);db.release();await pool.end() }
