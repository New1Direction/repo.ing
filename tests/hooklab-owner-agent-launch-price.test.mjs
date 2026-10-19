// The owner agent signs only the opening price it invited: the launch message's virtual_quote must equal the invite's
// fixed quote (or the standard 1 SOL quote for an unpriced invite). Synthetic message and keys; no RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import BN from 'bn.js'
import { BorshCoder } from '@anchor-lang/core'
import { AddressLookupTableAccount,ComputeBudgetProgram,Keypair,PublicKey,TransactionInstruction,TransactionMessage } from '@solana/web3.js'
import { checkAfterInvite,checkBeforeInvite,checkInvitePriceAgainst,invitedVirtualQuote,ownerRequestLines,policyAddress,verifyLaunchSignRequest } from '../src/hooklab-owner-agent.mjs'
import { STANDARD_VIRTUAL_QUOTE } from '../src/hooklab-launch-pricing.mjs'
import { maxWalletLaunchAccounts } from '../src/hooklab-max-wallet-launch.mjs'
import { productionArtifacts,productionProfileJson } from '../src/hooklab-production-operator-bundle.mjs'

const vendor=name=>JSON.parse(readFileSync(new URL(`../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/${name}`,import.meta.url)))
const launchCoder=new BorshCoder(vendor('bordrless_launch.json')),gateCoder=new BorshCoder(vendor('hook_max_wallet.json'))
const key=label=>Keypair.fromSeed(createHash('sha256').update(`OWNER AGENT PRICE TEST ONLY ${label}`).digest()).publicKey
const LAUNCH='E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft',GATE='BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb',admin=key('admin'),creator=key('creator'),mint=key('mint')
const approved={launchProgram:LAUNCH,gateProgram:GATE,admin:admin.toBase58(),creatorFeeChoices:[50,100,200],capChoices:[100,200,300,500],feeModel:2}
const pricing={solUsdMicros:'105630000',virtualQuote:'53251917070',pricedAt:'2026-10-19T17:00:00.000Z',
 sources:[{source:'coingecko',usdMicros:'105620000'},{source:'jupiter',usdMicros:'105630000'},{source:'coinbase',usdMicros:'105640000'}]}
const invited={id:'5b7f4c1e-8a0f-4d55-9a49-3f7c0c2b9d11',status:'launching',creator:creator.toBase58(),name:'Price Coin',symbol:'PRC',uri:'',creatorFeeBps:100,capBps:200,pricing}
const noRules={holder_fee_buy_bps:0,holder_fee_sell_bps:0,burn_buy_bps:0,burn_sell_bps:0,max_wallet_bps:0,creator_lock_secs:0,early_window_secs:0,early_lock_secs:0}

// One create_launch_custom_v3 call with the compiler's exact accounts (as the agent derives them from its pinned envelope
// and its own launch Config read), admin co-signing, and the read-only accounts in a lookup table (a launch does not fit a
// packet without one).
const {base,idls}=productionArtifacts(),envelope={json:productionProfileJson(base),idls:Object.fromEntries(Object.entries(idls).map(([role,bytes])=>[role,bytes.toString('base64')]))}
const launchConfigBytes=Buffer.from(JSON.parse(readFileSync(new URL('./fixtures/hooklab-mainnet-public-accounts.json',import.meta.url))).accounts['launch-config'].dataBase64,'base64'),selectedConfig=key('selected config')
const derived=maxWalletLaunchAccounts(envelope,{creator:creator.toBase58(),mint:mint.toBase58(),selectedConfig:selectedConfig.toBase58(),reviewer:admin.toBase58()},launchConfigBytes)
const launchKeys=derived.map(m=>({pubkey:new PublicKey(m.address),isSigner:m.signer,isWritable:m.writable}))
const table=new AddressLookupTableAccount({key:key('table'),state:{deactivationSlot:2n**64n-1n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:admin,
 addresses:[...new Set(derived.filter(m=>!m.signer&&!m.writable).map(m=>m.address))].map(a=>new PublicKey(a))}})
function signRequestFor(virtualQuote){
 const data=launchCoder.instruction.encode('create_launch_custom_v3',{args:{name:invited.name,symbol:invited.symbol,uri:invited.uri,creator_fee_bps:100,virtual_quote:new BN(virtualQuote),rules:noRules},
  guard:{version:2,deadline_slot:new BN(5000),expected_launch_economics_hash:Array(32).fill(1),expected_pool_economics_hash:Array(32).fill(2),
   max_launch_fee_lamports:new BN(0),max_pool_creation_fee_lamports:new BN(0),max_rent_lamports:new BN(1),max_total_debit_lamports:new BN(1)},
  fee_model:2,expected_control_hash:Array(32).fill(3),expected_hook_accounts_hash:Array(32).fill(4)})
 const keys=launchKeys
 const message=new TransactionMessage({payerKey:creator,recentBlockhash:key('blockhash').toBase58(),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1_000_000}),
  new TransactionInstruction({programId:new PublicKey(LAUNCH),keys,data})]}).compileToV0Message([table])
 const bytes=Buffer.from(message.serialize())
 return {messageBase64:bytes.toString('base64'),messageSha256:createHash('sha256').update(bytes).digest('hex'),signer:admin.toBase58(),validUntilSlot:'5000',lastValidBlockHeight:'9000'}
}
const policy=async()=>({address:policyAddress(GATE,mint.toBase58()),owner:GATE,data:await gateCoder.accounts.encode('PolicyV2',{version:2,mint,initial_supply:new BN('1000000000000000'),
 cap_bps:200,quote_mint:key('quote'),lp_fee_bps:0,fee_model:2,protocol_share_bps:2500,creator_fee_bps:100})})
const selected=async()=>({address:selectedConfig.toBase58(),owner:LAUNCH,data:await launchCoder.accounts.encode('LaunchConfig',{version:1,creator,rules:noRules,creator_fee_bps:100,
 custom_hook:new PublicKey(GATE),custom_hook_flags:1,label:'PRC',created_at:new BN(1),author_share_bps:0,reserved:Array(30).fill(0)})})
const verify=async(signRequest,over={})=>verifyLaunchSignRequest({signRequest,invited:{...invited,virtualQuote:invitedVirtualQuote(invited),...over},approved,lookupTables:[table],policy:await policy(),live:{slot:100,blockHeight:100},
 envelope,launchConfigBytes,selectedConfig:await selected()})

test('the agent signs only the virtual quote fixed with its invite',async()=>{
 const checked=await verify(signRequestFor(pricing.virtualQuote))
 assert.equal(checked.virtualQuote,'53251917070');assert.equal(checked.creator,invited.creator)
 for(const virtualQuote of [STANDARD_VIRTUAL_QUOTE,'53251917071','112500000000'])
  await assert.rejects(verify(signRequestFor(virtualQuote)),/opening price \(virtual quote\) differs from the invited request/,`message at ${virtualQuote}`)
 await assert.rejects(verify(signRequestFor(pricing.virtualQuote),{virtualQuote:undefined}),/invited opening price is missing/)
})

test('an unpriced invite (pricing off) signs only the standard 1 SOL quote',async()=>{
 const unpriced={...invited};delete unpriced.pricing
 assert.equal(invitedVirtualQuote(unpriced),STANDARD_VIRTUAL_QUOTE);assert.equal(invitedVirtualQuote({...invited,pricing:null}),STANDARD_VIRTUAL_QUOTE)
 assert.equal((await verify(signRequestFor(STANDARD_VIRTUAL_QUOTE),{virtualQuote:STANDARD_VIRTUAL_QUOTE})).virtualQuote,STANDARD_VIRTUAL_QUOTE)
 await assert.rejects(verify(signRequestFor(pricing.virtualQuote),{virtualQuote:STANDARD_VIRTUAL_QUOTE}),/opening price/)
})

test('a server price that does not re-derive is refused before the agent records the invite',()=>{
 assert.throws(()=>invitedVirtualQuote({...invited,pricing:{...pricing,virtualQuote:'112500000000'}}),/does not follow from its SOL price/)
 assert.throws(()=>invitedVirtualQuote({...invited,pricing:{...pricing,sources:pricing.sources.slice(0,1)}}),/at least two must agree/)
})

test('the agent reads SOL itself: a server price more than 3% from its own is never recorded',()=>{
 const own=usd=>[{source:'coinbase',usd},{source:'jupiter',usd}]
 assert.equal(checkInvitePriceAgainst(pricing,own(105.70)).solUsdMicros,'105700000','close to its own read: accepted')
 assert.equal(checkInvitePriceAgainst(pricing,own(108.79)).solUsdMicros,'108790000','just inside 3%')
 assert.throws(()=>checkInvitePriceAgainst(pricing,own(150)),/server SOL price \$105\.63 is more than 3% from this Mac's \$150\.00/,'a self-consistent but false server price is refused')
 assert.throws(()=>checkInvitePriceAgainst(pricing,own(102.5)),/more than 3%/)
 assert.throws(()=>checkInvitePriceAgainst(pricing,[{source:'coinbase',usd:150}]),/at least two must agree/,'no own quorum: nothing is recorded')
 assert.equal(checkInvitePriceAgainst(null,[]),null,'an unpriced invite needs no price read')
})

test('the agent checks the live on-chain limits before asking for an invite and again on the price it gets back',()=>{
 const today={min:1_000_000_000n,max:1_000_000_000n},widened={min:5_625_000_000n,max:112_500_000_000n}
 const own=[{source:'coinbase',usd:105.62},{source:'jupiter',usd:105.64}]
 assert.throws(()=>checkBeforeInvite({priced:true,ownReadings:own,bounds:today}),/On-chain limits are 1–1 SOL, but this launch would open at 53\.25 SOL\. Sign the launch-usd-bounds change first\./)
 assert.equal(checkBeforeInvite({priced:true,ownReadings:own,bounds:widened}),'53251917070')
 assert.throws(()=>checkBeforeInvite({priced:true,ownReadings:own.slice(0,1),bounds:widened}),/at least two must agree/,'no own SOL read: no invite')
 assert.equal(checkBeforeInvite({priced:false,ownReadings:[],bounds:today}),STANDARD_VIRTUAL_QUOTE,'pricing off: the standard quote, today’s limits')
 assert.throws(()=>checkBeforeInvite({priced:false,ownReadings:[],bounds:widened}),/would open at 1 SOL\. Deploy with HOOK_LAUNCH_USD_PRICING=true first\./)
 assert.equal(checkAfterInvite({confirmed:invited,ownReadings:own,bounds:widened}),'53251917070')
 assert.throws(()=>checkAfterInvite({confirmed:invited,ownReadings:own,bounds:today}),/On-chain limits are 1–1 SOL/,'limits changed between the two reads')
 assert.throws(()=>checkAfterInvite({confirmed:invited,ownReadings:[{source:'coinbase',usd:150},{source:'jupiter',usd:150}],bounds:widened}),/more than 3%/)
 const unpriced={...invited};delete unpriced.pricing
 assert.equal(checkAfterInvite({confirmed:unpriced,ownReadings:[],bounds:today}),STANDARD_VIRTUAL_QUOTE)
})

test('list shows the owner the fixed opening and graduation values, or when they will be fixed',()=>{
 assert.deepEqual(ownerRequestLines(invited),['    Opens at ≈$5,000 (53.25 SOL virtual), graduates at ≈$45,000 / 106.5 SOL raised · SOL $105.63 (coingecko $105.62, jupiter $105.63, coinbase $105.64)'])
 assert.deepEqual(ownerRequestLines({...invited,status:'queued',pricing:null}),['    price: fixed from the live SOL price when you invite'])
 const unpriced={...invited};delete unpriced.pricing
 assert.deepEqual(ownerRequestLines(unpriced),[],'pricing off: list is unchanged')
 assert.deepEqual(ownerRequestLines({...invited,pricing:null}),['    price: standard 1 SOL virtual quote (invited before USD pricing)'])
 assert.match(ownerRequestLines({...invited,pricing:{...pricing,virtualQuote:'1'}})[0],/^    price: REFUSED, nothing will be signed \(Launch opening price does not follow/)
})
