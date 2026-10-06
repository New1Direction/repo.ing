import { Connection } from '@solana/web3.js'
import { database } from '../app/lib/server.mjs'
import { createMarketConfigResolver } from '../src/market-config.mjs'
import { EARLY_ACCESS_NO_MANUAL_RECOVERY } from '../src/early-access.mjs'
import { EXPIRY_MARKET_COLUMNS, proveExpiredUnlandedLaunch, releaseExpiredLaunch } from '../src/launch-expiry.mjs'
// The worker releases these automatically (src/launch-indexer.mjs); this is the operator's manual path, with the same proof.
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
  const market = (await db.query(`select ${EXPIRY_MARKET_COLUMNS} from markets where github_repo_id=$1`,[repoId])).rows[0]
  if (!market) throw Error('Market not found')
  // A contributor early access launch (docs/EARLY_ACCESS.md) is on its own config: its manual recovery is a later step. The worker
  // still releases one with the same two-provider proof (src/launch-indexer.mjs).
  const { rows: [stamp] } = await db.query('select early_access_end is not null as "earlyAccess" from markets where id=$1', [market.id])
  if (stamp?.earlyAccess) throw Error(EARLY_ACCESS_NO_MANUAL_RECOVERY)
  createMarketConfigResolver(process.env.DBC_CONFIG)({ mint:market.mint,pool:market.pool })
  const proven = await proveExpiredUnlandedLaunch(connections, market)
  if (apply) await releaseExpiredLaunch(db, market, proven, 'operator-cli')
  console.log(JSON.stringify({repoId,...proven.proof,applied:apply,broadcast:false}))
} finally { await db.query('select pg_advisory_unlock($1::bigint)',[repoId]);db.release();await pool.end() }
