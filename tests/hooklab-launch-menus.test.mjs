// Creator fee and wallet-cap menus against the real inclusive preparation planner and the
// observed on-chain launch-config bytes. Synthetic fixtures only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BorshCoder } from '@anchor-lang/core'
import { planInclusiveMaxWalletPreparation } from '../src/hooklab-inclusive-max-wallet-preparation.mjs'
import { inclusiveMaxWalletProfileSchema } from '../src/hooklab-inclusive-max-wallet-profile.mjs'
import { CREATOR_FEE_BPS_CHOICES,DEFAULT_CREATOR_FEE_BPS,WALLET_CAP_BPS_CHOICES,DEFAULT_WALLET_CAP_BPS,CREATOR_FEE_CEILING_BPS,isApprovedLaunchChoice,isOpenCreatorFeeChoice } from '../src/hooklab-launch-menus.mjs'
import { inclusiveMaxWalletPreparationFixture } from './fixtures/hooklab-inclusive-max-wallet-preparation.mjs'
import { missingInclusiveArtifacts } from './fixtures/hooklab-generated-artifact.mjs'
const inclusiveVector = missingInclusiveArtifacts(['inclusive-builder-vector.json'])

const menus={creatorFeeBpsChoices:[...CREATOR_FEE_BPS_CHOICES],capBpsChoices:[...WALLET_CAP_BPS_CHOICES],defaultCapBps:DEFAULT_WALLET_CAP_BPS}
test('selected fees use the live ceiling while gates retain their discrete menu',()=>{
 const chain={creatorFeeBps:[50,100,200],maxCreatorFeeBps:200}
 for(const creatorFeeBps of [0,1,99,137,200])assert.ok(isOpenCreatorFeeChoice({creatorFeeBps,selectedHook:{}},chain))
 for(const creatorFeeBps of ['',null,-1,1.5,201,1000,NaN])assert.equal(isOpenCreatorFeeChoice({creatorFeeBps,selectedHook:{}},chain),false)
 assert.equal(isOpenCreatorFeeChoice({creatorFeeBps:0,selectedHook:{}},{...chain,maxCreatorFeeBps:undefined}),false)
 assert.equal(isOpenCreatorFeeChoice({creatorFeeBps:137,selectedHook:{}},{...chain,maxCreatorFeeBps:136}),false)
 for(const creatorFeeBps of [0,99,137])assert.equal(isOpenCreatorFeeChoice({creatorFeeBps},chain),false)
 for(const creatorFeeBps of chain.creatorFeeBps)assert.ok(isOpenCreatorFeeChoice({creatorFeeBps},chain))
})
test('a continuous fee (no fee menu on chain) is any whole bps from 0 to the ceiling; an empty filtered menu is not',()=>{
 const chain={creatorFeeBps:[],continuousCreatorFee:true,maxCreatorFeeBps:500}
 for(const creatorFeeBps of [0,1,137,500])assert.ok(isOpenCreatorFeeChoice({creatorFeeBps},chain))
 for(const creatorFeeBps of ['',null,-1,1.5,501,NaN])assert.equal(isOpenCreatorFeeChoice({creatorFeeBps},chain),false)
 assert.equal(isOpenCreatorFeeChoice({creatorFeeBps:100},{creatorFeeBps:[],maxCreatorFeeBps:500}),false)
})
function withMenus(f,{creatorFeeBps,capBps,ceiling}={}){
 const profile=JSON.parse(f.profile.json);profile.capability={...profile.capability,...menus,creatorFeeBps:DEFAULT_CREATOR_FEE_BPS}
 const json=JSON.stringify(profile);f.profile={...f.profile,json,expectedSha256:createHash('sha256').update(json).digest('hex')}
 if(creatorFeeBps!==undefined)f.request.creatorFeeBps=creatorFeeBps
 if(capBps!==undefined)f.request.capBps=capBps
 if(ceiling!==undefined){ // the governed launch-config change: both ceilings to `ceiling`
  const coder=new BorshCoder(JSON.parse(Buffer.from(f.profile.idls.launch,'base64')))
  for(const observation of f.observations){const a=observation.accounts[4].account,bytes=Buffer.from(a.dataBase64,'base64'),c=coder.accounts.decode('Config',bytes)
   c.max_creator_fee_bps=ceiling;c.rule_bounds.max_rules_fee_bps=ceiling
   const out=Buffer.alloc(bytes.length);bytes.subarray(0,8).copy(out);coder.types.encode('Config',c).copy(out,8);a.dataBase64=out.toString('base64')}
 }
 return f
}

test('approved menus are exactly the owner choices with valid defaults',{skip:inclusiveVector},()=>{
 assert.deepEqual(CREATOR_FEE_BPS_CHOICES,[50,100,200]);assert.equal(DEFAULT_CREATOR_FEE_BPS,100)
 assert.deepEqual(WALLET_CAP_BPS_CHOICES,[100,200,300,500]);assert.equal(DEFAULT_WALLET_CAP_BPS,200)
 assert.equal(CREATOR_FEE_CEILING_BPS,200,'config ceilings must be raised to 200 bps for the 2% option')
 const base=JSON.parse(inclusiveMaxWalletPreparationFixture().profile.json)
 const parse=capability=>inclusiveMaxWalletProfileSchema.parse({...base,capability:{...base.capability,...capability}})
 assert.deepEqual(parse({...menus,creatorFeeBps:100}).capability.capBpsChoices,[100,200,300,500])
 for(const bad of [{...menus,creatorFeeBps:75},{...menus,defaultCapBps:250},{...menus,creatorFeeBpsChoices:[50,50,100]},{capBpsChoices:[100]},{defaultCapBps:200}])
  assert.throws(()=>parse({creatorFeeBps:100,...bad}),undefined,JSON.stringify(bad))
 const profile=parse({...menus,creatorFeeBps:100})
 for(const fee of [50,100,200])for(const cap of [100,200,300,500])assert.ok(isApprovedLaunchChoice(profile,{creatorFeeBps:fee,capBps:cap}))
 for(const [fee,cap] of [[75,200],[0,200],[300,200],[100,250],[100,1000]])assert.ok(!isApprovedLaunchChoice(profile,{creatorFeeBps:fee,capBps:cap}))
 const single=JSON.parse(inclusiveMaxWalletPreparationFixture().profile.json)
 assert.ok(isApprovedLaunchChoice(single,{creatorFeeBps:100,capBps:4321})&&!isApprovedLaunchChoice(single,{creatorFeeBps:50,capBps:100}),'profiles without menus keep their single reviewed fee')
})

test('preparation accepts menu choices only within the on-chain launch-config ceilings',{skip:inclusiveVector},()=>{
 // Today's fixture ceilings are 100 bps: 0.5% and 1% fit, 2% does not until the governed raise.
 assert.equal(planInclusiveMaxWalletPreparation(withMenus(inclusiveMaxWalletPreparationFixture(),{creatorFeeBps:50,capBps:300})).policy.creatorFeeBps,50)
 assert.equal(planInclusiveMaxWalletPreparation(withMenus(inclusiveMaxWalletPreparationFixture(),{creatorFeeBps:100,capBps:200})).policy.capBps,200)
 assert.throws(()=>planInclusiveMaxWalletPreparation(withMenus(inclusiveMaxWalletPreparationFixture(),{creatorFeeBps:200,capBps:200})),/economics/,'2% refused at a 100 bps ceiling')
 const raised=planInclusiveMaxWalletPreparation(withMenus(inclusiveMaxWalletPreparationFixture(),{creatorFeeBps:200,capBps:500,ceiling:200}))
 assert.equal(raised.policy.creatorFeeBps,200);assert.equal(raised.policy.capBps,500)
 for(const choice of [{creatorFeeBps:75,capBps:200},{creatorFeeBps:100,capBps:250}])
  assert.throws(()=>planInclusiveMaxWalletPreparation(withMenus(inclusiveMaxWalletPreparationFixture(),{...choice,ceiling:200})),/economics/,JSON.stringify(choice))
})

// Regression (local burn e2e, 2026-10-27): a coin launched through open creation with a continuous fee (e.g. 3%, or the
// creator part of a burn split) carries that fee on chain; trades must accept it, not only the reviewed profile's menu.
test('a launched coin trades at any creator fee the open route allows, menu or not', async () => {
  const { isTradableCreatorFee } = await import('../src/hooklab-launch-menus.mjs')
  const profile = { capability: { creatorFeeBps: 100, creatorFeeBpsChoices: [50, 100, 200] } }
  for (const fee of [0, 50, 300, 500, 1000]) assert.equal(isTradableCreatorFee(profile, fee), true, String(fee))
  for (const fee of [1001, -1, 1.5, '300']) assert.equal(isTradableCreatorFee(profile, fee), false, String(fee))
})
