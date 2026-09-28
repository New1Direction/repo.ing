import test from 'node:test'
import assert from 'node:assert/strict'
import {operatingWalletObservation,createOperatingWalletMonitor} from '../src/operating-wallet-alerts.mjs'
import {createReserveWebhookSender,reserveAlertText} from '../src/reserve-alerts.mjs'
const point={genesis:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',slot:10,balance:10000000}
test('thresholds are exact and low balances require agreeing finalized evidence',()=>{
 assert.equal(operatingWalletObservation('payout','10000000',[point,point]).low,false)
 assert.equal(operatingWalletObservation('payout','10000001',[point,point]).low,true)
 for(const change of [{genesis:'devnet'},{slot:200},{balance:9999999},{balance:-1}])assert.throws(()=>operatingWalletObservation('payout','10000000',[point,{...point,...change}]))
})
test('Slack receives its supported text payload; webhook secrets are not part of the message',async()=>{
 const detail={role:'Builder payout signer',minimumLamports:'30000000',balanceLamports:'20000000',observedAt:'2026-09-28T00:00:00Z'}
 const text=reserveAlertText(4,detail);assert.match(text,/0.02 SOL/)
 const send=createReserveWebhookSender({env:{RESERVE_ALERT_WEBHOOK_URL:'https://hooks.slack.com/services/test/test/secret'},fetchImpl:async(url,opts)=>{
  assert.deepEqual(JSON.parse(opts.body),{text});assert.equal(opts.redirect,'error');assert.doesNotMatch(opts.body,/secret/);return {ok:true}
 }})
 assert.deepEqual(await send({id:4,text,detail}),{accepted:true})
})
test('monitor emits only low roles with a stable daily dedup key and no signing capability',async()=>{
 const events=[]
 const rpc={getGenesisHash:async()=>point.genesis,getBalanceAndContext:async()=>({context:{slot:10},value:20000000})}
 const m=createOperatingWalletMonitor({pool:{query:async(sql,args)=>{assert.match(sql,/on conflict/);events.push(args)}},connections:[rpc,rpc],
  env:{SOLANA_RPC_URL:'a',GRADUATION_VERIFICATION_RPC_URL:'b',OPS_PAYOUT_WALLET:'11111111111111111111111111111111',OPS_COLLECTION_WALLET:'11111111111111111111111111111111'},now:()=>Date.parse('2026-09-28T00:00:00Z')})
 await m.runOnce();await m.runOnce();assert.equal(events.length,2);assert.equal(events[0][0],events[1][0]);assert.match(events[0][0],/OPS_PAYOUT_WALLET/)
})
