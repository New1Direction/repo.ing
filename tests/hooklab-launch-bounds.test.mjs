// Live launch-config virtual-quote limits, read from the observed public mainnet config bytes through scripted
// providers. No RPC, keys or database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { checkLiveBounds,readLiveLaunchBounds } from '../src/hooklab-launch-bounds.mjs'
import { launchBoundsAtInvite } from '../app/lib/hooklab-launch-price.mjs'
import { STANDARD_VIRTUAL_QUOTE,VIRTUAL_QUOTE_BOUNDS } from '../src/hooklab-launch-pricing.mjs'
import { loadArtifacts } from '../src/hooklab-owner-driver/artifacts.mjs'
import { PROGRAMS,QUOTE_MINT,derivedAddresses } from '../src/hooklab-owner-driver/pins.mjs'

const fixture=JSON.parse(readFileSync(new URL('./fixtures/hooklab-mainnet-public-accounts.json',import.meta.url)))
const live=Buffer.from(fixture.accounts['launch-config'].dataBase64,'base64'),coder=loadArtifacts().coders.launch
const widened=Buffer.concat([live.subarray(0,8),coder.types.encode('Config',{...coder.accounts.decode('Config',live),min_virtual_quote:new BN('5625000000'),max_virtual_quote:new BN('112500000000')})])
const provider=(data,{owner=PROGRAMS.launch,fail=false}={})=>({async getAccountInfo(address,commitment){
 if(fail)throw Error('fetch failed: https://rpc.example/?api-key=SECRET')
 assert.equal(address.toBase58(),derivedAddresses(PROGRAMS, QUOTE_MINT).launchConfig);assert.equal(commitment,'finalized')
 return data&&{owner:new PublicKey(owner),data}}})

test('reads min/max virtual quote from the launch config both providers agree on',async()=>{
 assert.deepEqual(await readLiveLaunchBounds([provider(live),provider(live)]),{min:1_000_000_000n,max:1_000_000_000n},'today: 1-1 SOL')
 assert.deepEqual(await readLiveLaunchBounds([provider(widened),provider(widened)]),{min:VIRTUAL_QUOTE_BOUNDS.min,max:VIRTUAL_QUOTE_BOUNDS.max})
})

test('missing, foreign, disagreeing or unreadable config refuses without leaking the RPC URL',async()=>{
 for(const [connections,message] of [[[provider(live),provider(widened)],/providers disagree/],[[provider(null),provider(live)],/missing/],
  [[provider(live,{owner:PROGRAMS.swap}),provider(live,{owner:PROGRAMS.swap})],/missing/],[[provider(live)],/Two RPC providers/],[[provider(live),provider(live,{fail:true})],/Could not read/]]){
  await assert.rejects(readLiveLaunchBounds(connections),error=>error.code==='LAUNCH_PRICE_REFUSED'&&message.test(error.message)&&!/SECRET|rpc\.example/.test(error.message))
 }
})

test('an invite is refused when its quote is outside the live on-chain limits',()=>{
 const today={min:1_000_000_000n,max:1_000_000_000n}
 assert.throws(()=>checkLiveBounds('53251917070',today),/On-chain limits are 1–1 SOL, but this launch would open at 53\.25 SOL\. Sign the launch-usd-bounds change first\./)
 assert.doesNotThrow(()=>checkLiveBounds(STANDARD_VIRTUAL_QUOTE,today))
 const after={min:VIRTUAL_QUOTE_BOUNDS.min,max:VIRTUAL_QUOTE_BOUNDS.max}
 assert.doesNotThrow(()=>checkLiveBounds('53251917070',after))
 assert.throws(()=>checkLiveBounds(STANDARD_VIRTUAL_QUOTE,after),/On-chain limits are 5\.625–112\.5 SOL, but this launch would open at 1 SOL\. Deploy with HOOK_LAUNCH_USD_PRICING=true first\./)
 assert.throws(()=>checkLiveBounds('53251917070',null),/On-chain launch limits are unavailable/)
})

test('the server reads the limits through its two production RPC URLs',async()=>{
 const urls=[],connect=url=>{urls.push(url);return provider(widened)}
 const env={HOOKLAB_PRODUCTION_RPC_PRIMARY_URL:'https://primary.example/?k=1',HOOKLAB_PRODUCTION_RPC_SECONDARY_URL:'https://secondary.example'}
 assert.deepEqual(await launchBoundsAtInvite(env,connect),{min:VIRTUAL_QUOTE_BOUNDS.min,max:VIRTUAL_QUOTE_BOUNDS.max})
 assert.deepEqual(urls,[env.HOOKLAB_PRODUCTION_RPC_PRIMARY_URL,env.HOOKLAB_PRODUCTION_RPC_SECONDARY_URL])
 for(const bad of [{},{...env,HOOKLAB_PRODUCTION_RPC_SECONDARY_URL:env.HOOKLAB_PRODUCTION_RPC_PRIMARY_URL},{...env,HOOKLAB_PRODUCTION_RPC_PRIMARY_URL:'http://primary.example'}])
  await assert.rejects(launchBoundsAtInvite(bad,connect),/Two production RPC URLs are needed to check the on-chain launch limits/)
})
