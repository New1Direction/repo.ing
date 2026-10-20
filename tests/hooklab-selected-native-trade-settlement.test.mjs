// Fake finalized RPC framing and independently ABI-encoded CPI events; not SBF evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import {selectedNativeSettlementFixture} from './fixtures/selected-native-trade-settlement.mjs'
import {pk,pda} from './fixtures/selected-hook-preparation.mjs'

for(const side of ['buy','sell']) {
 test(`synthetic authenticated selected ${side} settles`,async()=>{
  const f=selectedNativeSettlementFixture(side),result=await f.settle()
  assert.equal(result.status,'finalized-success')
  assert.equal(result.authenticatedFeeEvent,true)
  assert.equal(result.authenticatedTokenBalanceEvents,true)
  assert.equal(result.quote.delivered,f.plan.quote.delivered)
 })
 for(const change of ['signed wire','program bytes','registry bytes','minimum output','forged authority','wrong ancestry','changed debit','forged cut target','changed cut amount','missing fee','duplicate transfer'])test(`synthetic selected ${side} rejects ${change}`,async()=>{
  const f=selectedNativeSettlementFixture(side)
  if(change==='signed wire'){
   const wire=Buffer.from(f.args.signedTransactionBase64,'base64');wire[1]^=1
   f.args.signedTransactionBase64=wire.toString('base64')
  }
  if(change==='program bytes'||change==='registry bytes'){
   const address=change==='program bytes'?f.request.selectedHook.program:pda(f.request.selectedHook.program,'bordrless-hook-accounts',pk(f.request.mint).toBuffer()),row=f.accounts.get(address),b=Buffer.from(row.dataBase64,'base64');b[b.length-1]^=1;row.dataBase64=b.toString('base64')
  }
  if(change==='minimum output'){f.events.Swapped.delivered_out=new BN(0);f.rebuild()}
  if(change==='changed debit'){f.events.Transferred.amount=f.events.Transferred.amount.addn(1);f.rebuild()}
  if(change==='forged cut target'){f.events.Transferred.deltas[0].holding=pk(f.a.traderBase);f.rebuild()}
  if(change==='changed cut amount'){f.events.Transferred.deltas[0].amount=f.events.Transferred.deltas[0].amount.addn(1);f.rebuild()}
  const instructions=f.receipt.meta.innerInstructions[0].instructions
  if(change==='forged authority')instructions.at(-1).accounts=[0]
  if(change==='wrong ancestry')instructions.at(-1).stackHeight=2
  if(change==='missing fee')instructions.shift()
  if(change==='duplicate transfer')instructions.push(structuredClone(instructions.at(-1)))
  assert.equal((await f.settle()).status,'unresolved')
 })
}
