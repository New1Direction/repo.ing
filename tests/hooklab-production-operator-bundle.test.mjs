// Synthetic two-provider chain built from the real pinned ELFs and public mainnet account bytes.
// Needs HOOKLAB_PRODUCTION_ELF_DIR (the reviewed rebuilt-inclusive ELFs); skips with a reason otherwise.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync,readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
import { collectProductionOperatorBundle,productionArtifacts,productionProfileJson,MAINNET_GENESIS } from '../src/hooklab-production-operator-bundle.mjs'
import { sharedTradeAddresses } from '../src/hooklab-owner-launch-tables.mjs'
import { validateMaxWalletOperatorBindings } from '../src/hooklab-max-wallet-launch-collector.mjs'

const elfDir=process.env.HOOKLAB_PRODUCTION_ELF_DIR
const skip=elfDir&&existsSync(`${elfDir}/hook_max_wallet.so`)?false:'set HOOKLAB_PRODUCTION_ELF_DIR to the reviewed rebuilt-inclusive ELF directory'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/hooklab-mainnet-public-accounts.json',import.meta.url)))
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),ALT_OWNER=new PublicKey('AddressLookupTab1e1111111111111111111111111')
const AUTHORITY='9GCfczwLVfyGTE4RRrEHbGqSdHGD35U3Z5ifo7YEN1md',ADMIN='DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5',TREASURY='FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i'
const LOOKUP_TABLE='Ehfpy1rTpv9uiVpmWUKgYfM6ZQ9bYxuPFNCcxtpgu2mv'
const trustDomains=[{provider:'helius',trustDomain:'helius',origin:'https://mainnet.helius-rpc.com'},{provider:'publicnode',trustDomain:'allnodes-publicnode',origin:'https://solana-rpc.publicnode.com'}]

function programData(elf,authority,slot=458600000){
 const header=Buffer.alloc(45);header.writeUInt32LE(3,0);header.writeBigUInt64LE(BigInt(slot),4)
 if(authority){header[12]=1;new PublicKey(authority).toBuffer().copy(header,13)}
 return Buffer.concat([header,elf])
}
// Shared trade table bytes: type 1, active, frozen (no authority) unless an authority is given.
function tradeTable({authority=null,addresses}={}){
 const shared=addresses??sharedTradeAddresses(JSON.parse(productionProfileJson(productionArtifacts().base))),h=Buffer.alloc(56);h.writeUInt32LE(1,0);h.writeBigUInt64LE(0xffffffffffffffffn,4)
 if(authority){h[21]=1;new PublicKey(authority).toBuffer().copy(h,22)}
 return Buffer.concat([h,...shared.map(a=>new PublicKey(a).toBuffer())])
}
function chain({gateAuthority=null,ceilings=200,share=2500,tamperLaunchElf=false,disagree=false,table=tradeTable()}={}){
 const {base,idls}=productionArtifacts(),P=base.programs,pda=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),new PublicKey(program))[0].toBase58()
 const elf=name=>readFileSync(`${elfDir}/${name}.so`),launchElf=elf('bordrless_launch');if(tamperLaunchElf)launchElf[100]^=1
 const accounts=new Map([
  [pda(LOADER,new PublicKey(P.launch).toBuffer()),{owner:LOADER,data:programData(launchElf,AUTHORITY)}],
  [pda(LOADER,new PublicKey(P.swap).toBuffer()),{owner:LOADER,data:programData(elf('bordrless_swap'),AUTHORITY)}],
  [pda(LOADER,new PublicKey(P.gate).toBuffer()),{owner:LOADER,data:programData(elf('hook_max_wallet'),gateAuthority)}],
  [pda(LOADER,new PublicKey(P.token).toBuffer()),{owner:LOADER,data:programData(elf('bordrless_token'),'5wni4K2qdSfTr6JspbLXDStfbq1XSmzMpF75RSpwsjBH')}],
  [LOOKUP_TABLE,{owner:ALT_OWNER,data:table}],
 ])
 // The approved governed config change applied to the public pre-deploy bytes.
 const edit=(role,mutate)=>{const coder=new BorshCoder(JSON.parse(idls[role.split('-')[0]])),a=fixture.accounts[role],bytes=Buffer.from(a.dataBase64,'base64'),c=coder.accounts.decode('Config',bytes);mutate(c)
  return Buffer.concat([bytes.subarray(0,8),coder.types.encode('Config',c)])}
 accounts.set(fixture.accounts['launch-config'].address,{owner:new PublicKey(P.launch),data:edit('launch-config',c=>{c.max_creator_fee_bps=ceilings;c.rule_bounds.max_rules_fee_bps=ceilings})})
 accounts.set(fixture.accounts['swap-config'].address,{owner:new PublicKey(P.swap),data:edit('swap-config',c=>{c.launch_protocol_share_bps=share})})
 for(const role of ['creation-control','swap-governance','quote-mint'])accounts.set(fixture.accounts[role].address,{owner:new PublicKey(fixture.accounts[role].owner),data:Buffer.from(fixture.accounts[role].dataBase64,'base64')})
 const connection=(origin,provider)=>({rpcEndpoint:`${origin}/?api-key=synthetic`,async getGenesisHash(){return MAINNET_GENESIS},async getSlot(){return 458600123},
  async getMultipleAccountsInfoAndContext(keys){return {context:{slot:458600123},value:keys.map(k=>{const a=accounts.get(k.toBase58());if(!a)return null
   const data=Buffer.from(a.data);if(disagree&&provider==='publicnode'&&k.toBase58()===fixture.accounts['swap-config'].address)data[data.length-1]^=1
   return {owner:a.owner,executable:false,lamports:1,data}})}}})
 return trustDomains.map(t=>({provider:t.provider,connection:connection(t.origin,t.provider)}))
}
const collect=options=>collectProductionOperatorBundle({connections:chain(options),trustDomains,lookupTable:LOOKUP_TABLE,reviewer:ADMIN,treasury:TREASURY,approvalReference:'SYNTHETIC-TEST'})

test('production bundle from the pinned build passes the server start-up validation',{skip},async()=>{
 const connections=chain(),bundle=await collectProductionOperatorBundle({connections,trustDomains,lookupTable:LOOKUP_TABLE,reviewer:ADMIN,treasury:TREASURY,approvalReference:'SYNTHETIC-TEST'})
 const profile=JSON.parse(bundle.profile.json)
 assert.deepEqual(profile.capability.creatorFeeBpsChoices,[50,100,200]);assert.deepEqual(profile.capability.capBpsChoices,[100,200,300,500])
 assert.equal(profile.capability.creatorFeeBps,100);assert.equal(profile.capability.defaultCapBps,200)
 const dossier=JSON.parse(bundle.dossierJson)
 assert.equal(dossier.programs.find(p=>p.role==='gate').upgradeAuthority,null)
 assert.deepEqual(dossier.programs.map(p=>p.role),['launch','swap','gate','token'])
 const validated=validateMaxWalletOperatorBindings({config:bundle.config,profile:bundle.profile,dossierJson:bundle.dossierJson,connections})
 assert.equal(validated.config.economics.launchProtocolShareBps,2500);assert.equal(validated.config.reviewer,ADMIN);assert.equal(validated.config.treasury,TREASURY)
})

test('production bundle refuses an upgradeable gate, unapplied economics, drifted code and disagreeing providers',{skip},async()=>{
 await assert.rejects(collect({gateAuthority:AUTHORITY}),/gate is still upgradeable/)
 await assert.rejects(collect({ceilings:100}),/fee ceilings are below 200/)
 await assert.rejects(collect({share:0}),/inclusive 25% split/)
 await assert.rejects(collect({tamperLaunchElf:true}),/launch deployed code differs/)
 await assert.rejects(collect({disagree:true}),/providers disagree/)
 await assert.rejects(collect({table:tradeTable({authority:AUTHORITY})}),/not frozen/)
 await assert.rejects(collect({table:tradeTable({addresses:[AUTHORITY]})}),/addresses differ/)
})
