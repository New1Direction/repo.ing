// Per-launch lookup tables from the reviewed production profile and public mainnet config bytes.
// Synthetic wallets only; no RPC, database or keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Keypair,PublicKey,TransactionMessage,VersionedTransaction } from '@solana/web3.js'
import { productionArtifacts,productionProfileJson } from '../src/hooklab-production-operator-bundle.mjs'
import { launchTableInventory,verifyTableRequest,verifyLaunchTable,launchTableInstructions,TABLE_CHUNK } from '../src/hooklab-owner-launch-tables.mjs'

const ADMIN='DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/hooklab-mainnet-public-accounts.json',import.meta.url)))
const {base,idls}=productionArtifacts()
const envelope={json:productionProfileJson(base),idls:Object.fromEntries(Object.entries(idls).map(([role,bytes])=>[role,bytes.toString('base64')]))}
const launchConfigBytes=Buffer.from(fixture.accounts['launch-config'].dataBase64,'base64')
const key=label=>Keypair.fromSeed(createHash('sha256').update(`OWNER TABLE TEST ONLY ${label}`).digest()).publicKey.toBase58()
const creator=key('creator')
const invited={id:'5b7f4c1e-8a0f-4d55-9a49-3f7c0c2b9d11',custodyOperationId:'0f3c9a52-6a43-4e0e-b8a8-2a1c1d9e7b10',status:'launching',creator,name:'Table Coin',symbol:'TBL',uri:'',creatorFeeBps:100,capBps:200,virtualQuote:'1000000000'}
const launchRequest=(over={})=>({schema:'repoing/inclusive-max-wallet-launch-request/1',policyKind:'max-wallet',policyVersion:2,creator,feePayer:creator,mint:key('mint'),
 selectedConfig:key('selected'),capBps:200,label:'customer',creatorFeeBps:100,rules:'none',hookFlags:1,feeModel:2,protocolShareBps:2500,reviewer:ADMIN,
 name:'Table Coin',symbol:'TBL',uri:'',virtualQuote:'1000000000',...over})
const tableRequestFor=(request,over={})=>{const own=launchTableInventory(envelope,request,launchConfigBytes)
 return {preparationId:'0f3c9a52-6a43-4e0e-b8a8-2a1c1d9e7b10',launchRequestId:invited.id,creator,launchRequest:request,...own,status:'requested',...over}}
// Address lookup table account bytes: type, deactivation slot, last extended slot, start index, authority option, padding, addresses.
function tableBytes(addresses,{authority=ADMIN,deactivationSlot=0xffffffffffffffffn}={}){
 const header=Buffer.alloc(56);header.writeUInt32LE(1,0);header.writeBigUInt64LE(deactivationSlot,4);header.writeBigUInt64LE(100n,12)
 if(authority){header[21]=1;new PublicKey(authority).toBuffer().copy(header,22)}
 return Buffer.concat([header,...addresses.map(a=>new PublicKey(a).toBuffer())])
}

test('each launch needs its own 38-address inventory; the shared part alone is not enough',()=>{
 const a=launchTableInventory(envelope,launchRequest(),launchConfigBytes),b=launchTableInventory(envelope,launchRequest({mint:key('other-mint'),selectedConfig:key('other-selected')}),launchConfigBytes)
 assert.equal(a.inventory.length,38);assert.deepEqual(a.inventory,[...a.inventory].sort())
 assert.notEqual(a.inventorySha256,b.inventorySha256)
 assert.ok(a.inventory.filter(x=>!b.inventory.includes(x)).length>=10,'mint-specific addresses differ between launches')
})

test('the agent accepts only a table request that matches the invited launch and its own derivation',()=>{
 const request=launchRequest(),ok=tableRequestFor(request)
 assert.equal(verifyTableRequest({tableRequest:ok,invited,envelope,launchConfigBytes,adminAddress:ADMIN}).inventory.length,38)
 for(const [change,label] of [[{name:'Other'},'name'],[{symbol:'X'},'symbol'],[{uri:'https://x.example'},'uri'],[{creatorFeeBps:200},'fee'],[{capBps:500},'cap'],
  [{feePayer:key('payer')},'fee payer'],[{reviewer:key('reviewer')},'reviewer'],[{creator:key('someone')},'creator'],[{virtualQuote:'53251917070'},'opening price']]){
  assert.throws(()=>verifyTableRequest({tableRequest:{...ok,launchRequest:{...request,...change}},invited,envelope,launchConfigBytes,adminAddress:ADMIN}),/differs|derivation/,label)
 }
 assert.throws(()=>verifyTableRequest({tableRequest:ok,invited:{...invited,virtualQuote:undefined},envelope,launchConfigBytes,adminAddress:ADMIN}),/differs/,'the opening price comes from the agent ledger, never assumed')
 const tampered={...ok,inventory:[...ok.inventory.slice(0,-1),key('attacker')]}
 assert.throws(()=>verifyTableRequest({tableRequest:tampered,invited,envelope,launchConfigBytes,adminAddress:ADMIN}),/own derivation/)
 for(const other of [undefined,{...invited,status:'invited'},{...invited,id:'00000000-0000-4000-8000-000000000000'},{...invited,creator:key('x')},{...invited,custodyOperationId:'00000000-0000-4000-8000-000000000001'}])
  assert.throws(()=>verifyTableRequest({tableRequest:ok,invited:other,envelope,launchConfigBytes,adminAddress:ADMIN}),/No launching request/)
})

test('table transactions fit a packet and the created table must be exact, active and admin-owned',()=>{
 const {inventory}=launchTableInventory(envelope,launchRequest(),launchConfigBytes)
 const {table,steps}=launchTableInstructions({admin:ADMIN,recentSlot:458600000,inventory,microLamports:10000})
 assert.equal(steps.length,Math.ceil(inventory.length/TABLE_CHUNK))
 for(const instructions of steps){
  const message=new TransactionMessage({payerKey:new PublicKey(ADMIN),recentBlockhash:key('blockhash'),instructions}).compileToV0Message()
  assert.ok(new VersionedTransaction(message).serialize().length<=1232)
 }
 const owner='AddressLookupTab1e1111111111111111111111111'
 assert.equal(verifyLaunchTable({data:tableBytes(inventory),owner,inventory,adminAddress:ADMIN}).addresses.length,38)
 for(const [data,label] of [[tableBytes(inventory,{authority:key('other')}),'authority'],[tableBytes(inventory,{authority:null}),'frozen'],
  [tableBytes(inventory,{deactivationSlot:5n}),'deactivated'],[tableBytes([...inventory].reverse()),'order'],[tableBytes(inventory.slice(1)),'missing']])
  assert.throws(()=>verifyLaunchTable({data,owner,inventory,adminAddress:ADMIN}),/differ/,label)
 assert.throws(()=>verifyLaunchTable({data:tableBytes(inventory),owner:key('owner'),inventory,adminAddress:ADMIN}),/not an address lookup table/)
 assert.match(table,/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
})
