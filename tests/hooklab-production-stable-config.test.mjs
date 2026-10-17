import test from 'node:test'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {BorshCoder} from '@anchor-lang/core'
import {maxWalletOperatorFixture} from './fixtures/hooklab-max-wallet-operator.mjs'
import {inclusiveMaxWalletLaunchFixture,inclusiveTokenElf} from './fixtures/hooklab-inclusive-max-wallet-launch.mjs'
import {compileMaxWalletLaunchReview} from '../src/hooklab-max-wallet-launch.mjs'
import {productionAccountBindingMatches,productionDossierSchema} from '../src/hooklab-production-observer.mjs'
test('schema2 binds canonical Config and ignores only monotonic named counters',()=>{
 const f=maxWalletOperatorFixture(x=>x,{baseFixture:inclusiveMaxWalletLaunchFixture,compile:compileMaxWalletLaunchReview,tokenElf:inclusiveTokenElf()}),d=JSON.parse(f.dossierJson)
 for(const role of ['launch','swap']){
  const pin=d.accounts.find(p=>p.role===`${role}-config`),a=f.accounts.get(pin.address),coder=new BorshCoder(JSON.parse(Buffer.from(f.profile.idls[role],'base64'))),raw=Buffer.from(a.dataBase64,'base64'),value=coder.accounts.decode('Config',raw),field=role==='launch'?'launches':'pools_created'
  const account=v=>({...a,dataBase64:Buffer.concat([raw.subarray(0,8),coder.types.encode('Config',v)]).toString('base64')})
  assert.ok(productionAccountBindingMatches(pin,a,d));value[field]=value[field].addn(2);assert.ok(productionAccountBindingMatches(pin,account(value),d))
  const exact={...pin};delete exact.binding;delete exact.approvedDataBase64;delete exact.idlSha256;assert.equal(productionAccountBindingMatches(exact,account(value),{...d,schema:'repoing/production-observation/1'}),false)
  const raised=account(value),raisedPin={...pin,approvedDataBase64:raised.dataBase64,dataSha256:createHash('sha256').update(Buffer.from(raised.dataBase64,'base64')).digest('hex')};value[field]=value[field].subn(1);assert.equal(productionAccountBindingMatches(raisedPin,account(value),d),false);value[field]=value[field].addn(1)
  const economics=role==='launch'?'max_creator_fee_bps':'launch_protocol_share_bps';value[economics]++;assert.equal(productionAccountBindingMatches(pin,account(value),d),false)
  for(const patch of [{binding:'unknown'},{address:d.accounts.find(p=>p.role==='quote-mint').address},{idlSha256:'0'.repeat(64)},{role:'quote-mint'},{dataSha256:'0'.repeat(64)}])assert.equal(productionAccountBindingMatches({...pin,...patch},a,d),false)
  assert.equal(productionAccountBindingMatches(pin,{...a,dataBase64:Buffer.concat([raw,Buffer.from([0])]).toString('base64')},d),false)
 }
 assert.throws(()=>productionDossierSchema.parse({...d,schema:'repoing/production-observation/1'}))
})
