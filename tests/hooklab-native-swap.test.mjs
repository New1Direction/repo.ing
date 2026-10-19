// The native-SOL swap compiler's fixed parts, without a bank: the request it accepts, the swap_v2 account order it
// builds against the reviewed IDL, the accounts it reads, and the profile it refuses. tests/hooklab-native-trade.test.mjs
// proves the compiled transactions on the reviewed ELFs.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {Keypair,PublicKey} from '@solana/web3.js'
import {RENT_SYSVAR,compileNativeSwapReview,nativeSwapInventory,nativeSwapRequestSchema,nativeSwapV2Instruction} from '../src/hooklab-native-swap.mjs'
import {loadNativeArtifacts} from '../src/hooklab-native-pins.mjs'
import {hookCoinAddresses} from '../src/hooklab-inclusive-max-wallet-swap.mjs'
import {PROGRAMS,QUOTE_MINT,holdingAddress} from '../src/hooklab-owner-driver/pins.mjs'

const key=()=>Keypair.generate().publicKey.toBase58(),trader=key(),mint=key(),selectedConfig=key()
const profile=JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/offline-builder-profile.json',import.meta.url)))
const request=(extra={})=>({schema:'repoing/native-swap-request/1',policyKind:'max-wallet',policyVersion:2,creatorFeeBps:100,feeModel:2,protocolShareBps:2500,capBps:200,
 side:'buy',trader,mint,selectedConfig,amountIn:'1000003',minAmountOut:'1',maxInput:'1000003',maxPriceImpactBps:1000,graduate:false,...extra})

test('the request is exact: a graduating sell, a missing graduate flag or an extra field is refused',()=>{
 assert.ok(nativeSwapRequestSchema.parse(request()));assert.ok(nativeSwapRequestSchema.parse(request({graduate:true})))
 assert.throws(()=>nativeSwapRequestSchema.parse(request({side:'sell',graduate:true})),/Only a buy graduates/)
 const {graduate,...missing}=request();assert.throws(()=>nativeSwapRequestSchema.parse(missing))
 for(const extra of [{recipient:key()},{feePayer:key()},{maxPriceImpactBps:1001},{feeModel:1},{amountIn:'0'}])assert.throws(()=>nativeSwapRequestSchema.parse(request(extra)),JSON.stringify(extra))
})

test('swap_v2 follows the reviewed IDL account order: the trader pays on a buy and is paid on a sale, the fee policy last',()=>{
 const {idls,coders}=loadNativeArtifacts(),abi=idls.swap.instructions.find(ix=>ix.name==='swap_v2'),a=hookCoinAddresses({programs:PROGRAMS,quoteMint:QUOTE_MINT},mint)
 for(const side of ['buy','sell']){
  const ix=nativeSwapV2Instruction({programs:PROGRAMS,quoteMint:QUOTE_MINT},{side,trader,mint,amountIn:1000003n,minAmountOut:5n}),keys=ix.keys.map(k=>k.pubkey.toBase58())
  assert.equal(ix.programId.toBase58(),PROGRAMS.swap)
  assert.deepEqual(keys.slice(0,15),[trader,a.swapConfig,a.pool,mint,QUOTE_MINT,a.baseVault,holdingAddress(mint,trader),trader,PROGRAMS.launch,a.swapHookSigner,PROGRAMS.token,a.tokenEventAuthority,
   '11111111111111111111111111111111',a.swapEventAuthority,PROGRAMS.swap])
  assert.deepEqual(abi.accounts.map(x=>[!!x.signer,!!x.writable]),ix.keys.slice(0,15).map(k=>[k.isSigner,k.isWritable]))
  assert.deepEqual(keys.slice(15),[PROGRAMS.gate,a.gateHookSigner,a.policy,a.launch,a.launch,a.launchQuote,a.holderVault,a.kitConfig,a.inclusiveFeePolicy],'gate slice, pool-hook extras, policy last')
  assert.ok(!keys.includes(a.quoteVault),'no quote vault and no bridge account')
  const {args}=coders.swap.instruction.decode(ix.data).data
  assert.deepEqual([args.direction,args.amount_in.toString(),args.min_amount_out.toString(),args.in_hook_accounts,args.out_hook_accounts],side==='buy'?[1,'1000003','5',0,4]:[0,'1000003','5',4,0])
 }
 // The reviewed vector's swap_v2 bytes (hook-lab native-v4-vectors.json) decode with the same coder.
 assert.equal(coders.swap.instruction.decode(Buffer.from(loadNativeArtifacts().vectors.swap_v2_data,'hex')).name,'swap_v2')
})

test('every native trade reads the same fixed account list, including the rent sysvar and graduate’s signers',()=>{
 const inventory=nativeSwapInventory(profile,request()),again=nativeSwapInventory(profile,request({side:'sell',amountIn:'7',maxInput:'7'}))
 assert.deepEqual(inventory,[...inventory].sort());assert.deepEqual(inventory,again,'buy and sell read the same accounts')
 const signer=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),new PublicKey(program))[0].toBase58()
 for(const address of [RENT_SYSVAR,trader,holdingAddress(mint,trader),PROGRAMS.launch,PROGRAMS.swap,PROGRAMS.gate,PROGRAMS.token,
  signer(PROGRAMS.launch,'hook-authority'),signer(PROGRAMS.launch,'__event_authority')])assert.ok(inventory.includes(address),address)
 assert.ok(inventory.length<=64)
})

test('a profile that does not pin the reviewed native builds is refused before any state is read',()=>{
 const json=readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/offline-builder-profile.json',import.meta.url),'utf8')
 const idl=name=>readFileSync(new URL(`../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/${name}.json`,import.meta.url)).toString('base64')
 const rows=Array.from({length:20},()=>({address:key(),account:null}))
 const input={profile:{json,expectedSha256:'0'.repeat(64),idls:{launch:idl('bordrless_launch'),swap:idl('bordrless_swap'),gate:idl('hook_max_wallet')},elfLengths:{launch:759976,swap:554808,gate:188960},providers:['a','b']},
  request:request(),provenance:'server-collected-finalized-state-not-execution-authorization',
  observations:['a','b'].map(provider=>({provider,genesisHash:profile.genesisHash,commitment:'finalized',slot:1,observedAtMs:1,accounts:rows})),
  recentBlockhash:{blockhash:key(),genesisHash:profile.genesisHash,providers:['a','b'],observedAtMs:1,currentBlockHeight:1,blockhashValid:true,lastValidBlockHeight:2,observedSlot:1,networkFeeLamports:'5000',lamportsPerSignature:'5000'},
  lookupTable:null,limits:{nowMs:1,maxAgeMs:5000,maxSlotLag:5,validUntilSlot:2,reviewExpiresAtMs:2,maxNetworkFeeLamports:'5000',maxTotalDebitLamports:'5000',computeUnitLimit:1400000,computeUnitPriceMicroLamports:'0'}}
 assert.throws(()=>compileNativeSwapReview(input),/profile digest/)
 input.profile.expectedSha256=createHash('sha256').update(json).digest('hex')
 assert.throws(()=>compileNativeSwapReview(input),/does not pin the reviewed native builds/,'today’s bridged builds')
})
