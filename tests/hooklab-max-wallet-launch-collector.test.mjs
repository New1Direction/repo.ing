import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BorshCoder } from '@anchor-lang/core'
import { PublicKey } from '@solana/web3.js'
import { maxWalletLaunchFixture } from './fixtures/hooklab-max-wallet-launch.mjs'
import { maxWalletPreparationRequest } from './fixtures/hooklab-max-wallet-preparation.mjs'
import { buildMaxWalletLaunchReviewForFixture,compileMaxWalletLaunchReview } from '../src/hooklab-max-wallet-launch.mjs'
import { collectMaxWalletLaunchReview,validateMaxWalletOperatorBindings } from '../src/hooklab-max-wallet-launch-collector.mjs'
import { coLocatedMaxWalletLaunchResolver } from '../src/hooklab-max-wallet-launch-resolver.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex'),pk=x=>new PublicKey(x),loader='BPFLoaderUpgradeab1e11111111111111111111111'
// Injected fake RPC for deterministic local tests only. No fixture adapter is
// imported by any production module; these tests do not establish live readiness.
import { maxWalletOperatorFixture as fixture } from './fixtures/hooklab-max-wallet-operator.mjs'
import { missingGeneratedArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'
// Every case needs private generated artifacts; without them each skips with the reason below.
const test = testRequiring(missingGeneratedArtifacts(['hooklab-max-wallet-rust-vector.json']))

test('collector uses actual deterministic compiler with separate durable proof schema and exact fixture-vector instruction bytes',async()=>{
 const f=fixture(),out=await collectMaxWalletLaunchReview(f)
 assert.equal(out.plan.canonicalInstruction.dataHex,f.baseline.canonicalInstruction.dataHex)
 assert.equal(out.plan.review.messageBase64,f.baseline.review.messageBase64)
 assert.equal(out.plan.review.operation,'max-wallet-launch');assert.equal(out.plan.status,'unauthenticated-deterministic-review-only')
 assert.equal(out.canSign,false);assert.equal(out.canSubmit,false);assert.equal(out.collection.feeQuotedByBoth,true)
 assert.throws(()=>compileMaxWalletLaunchReview(f.f))
})
for(const [name,mutate] of [
 ['disabled config',f=>{f.config.enabled=false}],['default-off config',f=>{delete f.config.enabled}],['unapproved creator fee',f=>{f.config.economics.creatorFeeBps=50}],['missing economics',f=>{delete f.config.economics}],
 ['wrong fee split',f=>{f.config.economics.launchProtocolShareBps++}],['wrong admin',f=>{f.config.reviewer=f.request.mint}],['wrong label',f=>{f.request.label+='x'}],['wrong cap',f=>{f.request.capBps++}],
 ['same trust domain',f=>{f.config.providerTrustDomains[1].trustDomain=f.config.providerTrustDomains[0].trustDomain}],['same endpoint',f=>{f.connections[1].connection.rpcEndpoint=f.connections[0].connection.rpcEndpoint}],
 ['missing endpoint',f=>{delete f.connections[1].connection.rpcEndpoint}],['wrong profile pin',f=>{f.config.profileSha256='0'.repeat(64)}],['changed dossier',f=>{f.dossierJson+=' '}],
 ['wrong durable owner',f=>{f.preparation.wallet=f.request.mint}],['wrong durable hashes',f=>{f.preparation.preparedAccountHashes.policy='0'.repeat(64)}],
 ['wrong chain',f=>{f.connections[1].connection.getGenesisHash=async()=>f.request.mint}],['provider snapshot drift',f=>{const old=f.connections[1].connection.getMultipleAccountsInfoAndContext;f.connections[1].connection.getMultipleAccountsInfoAndContext=async k=>{const r=await old(k);r.value.find(Boolean).lamports++;return r}}],
 ['wrong fee quote',f=>{f.connections[1].connection.getFeeForMessage=async()=>({context:{slot:f.f.recentBlockhash.observedSlot},value:1})}],
 ['invalid blockhash',f=>{f.connections[1].connection.isBlockhashValid=async()=>({context:{slot:f.f.recentBlockhash.observedSlot},value:false})}],
 ['expired collection',f=>{f.clock=()=>9000}],['changed ALT',f=>{f.config.lookupTable.sha256='0'.repeat(64)}],
])test(`rejects ${name} without a review`,async()=>{const f=fixture();mutate(f);await assert.rejects(collectMaxWalletLaunchReview(f))})
test('server resolver rejects disabled config before any database work',()=>{const f=fixture();f.config.enabled=false;assert.throws(()=>coLocatedMaxWalletLaunchResolver({connect(){assert.fail('database touched')}},{origin:'https://repo.ing',...f}),/disabled/)})

test('revalidation preserves exact retained review without requesting a new blockhash',async()=>{
 const f=fixture(),first=await collectMaxWalletLaunchReview(f)
 f.connections[0].connection.getLatestBlockhashAndContext=async()=>{assert.fail('must retain the wallet-consented blockhash')}
 f.clock=()=>1100
 const next=await collectMaxWalletLaunchReview({...f,expectedReview:first.plan.review})
 assert.deepEqual(next.plan.review,first.plan.review);assert.equal(next.observedAdmin,f.request.reviewer)
 const changed=structuredClone(first.plan.review);changed.maxFeeLamports='16000'
 await assert.rejects(collectMaxWalletLaunchReview({...f,expectedReview:changed}))
 f.connections[1].connection.isBlockhashValid=async()=>({context:{slot:f.f.recentBlockhash.observedSlot},value:false})
 await assert.rejects(collectMaxWalletLaunchReview({...f,expectedReview:first.plan.review}))
})

test('RPC transport errors never expose URLs or credentials',async()=>{
 const f=fixture();f.connections[0].connection.getGenesisHash=async()=>{throw Error('https://private.invalid/?api-key=SECRET')}
 await assert.rejects(collectMaxWalletLaunchReview(f),error=>error.code==='MAX_WALLET_LAUNCH_UNAVAILABLE'&&!String(error).includes('SECRET')&&!String(error).includes('private.invalid'))
})
