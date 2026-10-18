#!/usr/bin/env node
// Read-only: writes the production operator bundle the server pins by hash. Never signs or sends.
// RPC URLs come from the environment (they may hold API keys), in the SAME order the server uses:
//   HOOKLAB_PRODUCTION_RPC_PRIMARY_URL, HOOKLAB_PRODUCTION_RPC_SECONDARY_URL
//
//   node scripts/hooklab-production-bundle.mjs --trade-table ADDRESS --approval-reference TEXT --out config/hooklab-production-bundle.json
//
// It refuses unless the gate is finalized, every program matches its reviewed pin, both configs carry
// the approved economics, and both providers return identical bytes.
import { existsSync,writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { Connection } from '@solana/web3.js'
import { collectProductionOperatorBundle } from '../src/hooklab-production-operator-bundle.mjs'
const ADMIN='DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5',TREASURY='FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i'
// Provider name and trust domain by host; anything else must be reviewed and added here first.
const KNOWN=[[/(^|\.)helius-rpc\.com$/,'helius','helius'],[/(^|\.)publicnode\.com$/,'publicnode','allnodes-publicnode'],[/(^|\.)rpcpool\.com$/,'triton','triton-one'],
 [/^api\.mainnet-beta\.solana\.com$/,'solana-labs','solana-foundation']]
const {values:opt}=parseArgs({options:{'trade-table':{type:'string'},'approval-reference':{type:'string'},out:{type:'string'}}})
const die=message=>{console.error(message);process.exit(2)}
if(!opt['trade-table']||!opt['approval-reference']||!opt.out)die('Required: --trade-table ADDRESS --approval-reference TEXT --out FILE')
if(existsSync(opt.out))die(`${opt.out} exists; refusing to overwrite`)
const urls=[process.env.HOOKLAB_PRODUCTION_RPC_PRIMARY_URL,process.env.HOOKLAB_PRODUCTION_RPC_SECONDARY_URL]
if(!urls.every(u=>typeof u==='string'&&u.startsWith('https://')))die('Set HOOKLAB_PRODUCTION_RPC_PRIMARY_URL and HOOKLAB_PRODUCTION_RPC_SECONDARY_URL (HTTPS) first.')
const trustDomains=urls.map(url=>{const {host,origin}=new URL(url),known=KNOWN.find(([pattern])=>pattern.test(host))
 if(!known)die(`Unreviewed RPC host ${host}; add it to the reviewed list first.`);return {provider:known[1],trustDomain:known[2],origin}})
if(trustDomains[0].trustDomain===trustDomains[1].trustDomain)die('The two RPC URLs must be independent providers.')
const connections=urls.map((url,i)=>({provider:trustDomains[i].provider,connection:new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true})}))
try{
 const bundle=await collectProductionOperatorBundle({connections,trustDomains,lookupTable:opt['trade-table'],reviewer:ADMIN,treasury:TREASURY,approvalReference:opt['approval-reference']})
 const bytes=Buffer.from(JSON.stringify(bundle))
 writeFileSync(opt.out,bytes,{flag:'wx',mode:0o644})
 console.log(`Wrote ${opt.out} (observed slot ${bundle.observedSlot}; providers ${trustDomains.map(t=>t.provider).join(' + ')}).`)
 console.log('Railway variables for this bundle:')
 console.log(`  HOOKLAB_PRODUCTION_BUNDLE_FILE=${opt.out}`)
 console.log(`  HOOKLAB_PRODUCTION_BUNDLE_SHA256=${createHash('sha256').update(bytes).digest('hex')}`)
}catch(error){die(error?.code==='PRODUCTION_BUNDLE_REFUSED'?error.message:`Bundle not written: ${error.message}`)}
