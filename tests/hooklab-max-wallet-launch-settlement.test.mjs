import assert from 'node:assert/strict'
import {collectMaxWalletLaunchSettlement} from '../src/hooklab-max-wallet-launch-settlement.mjs'
import {maxWalletSettlementFixture} from './fixtures/hooklab-max-wallet-launch-settlement.mjs'
import { missingGeneratedArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'
// Every case needs private generated artifacts; without them each skips with the reason below.
const test = testRequiring(missingGeneratedArtifacts(['hooklab-max-wallet-rust-vector.json']))
test('exact signed launch, finalized inclusion, authenticated events and full initial postconditions settle immutably',async()=>{
 const f=await maxWalletSettlementFixture(),first=await collectMaxWalletLaunchSettlement(f)
 assert.equal(first.status,'finalized-success');assert.equal(first.signature,f.signature)
 const original=f.connections[0].connection.getMultipleAccountsInfoAndContext
 for(const {connection}of f.connections)connection.getMultipleAccountsInfoAndContext=async(...args)=>{const v=await original(...args);v.context.slot+=5;return v}
 assert.deepEqual(await collectMaxWalletLaunchSettlement(f),first)
})
test('finalized failure requires exact fee-only balances and never becomes success',async()=>{
 const f=await maxWalletSettlementFixture();f.transaction.meta.err={InstructionError:[2,'Custom']};f.transaction.meta.postBalances=[...f.transaction.meta.preBalances]
 f.transaction.meta.postBalances[0]-=f.transaction.meta.fee
 assert.equal((await collectMaxWalletLaunchSettlement(f)).status,'finalized-failure')
 f.transaction.meta.postBalances[1]++
 assert.equal((await collectMaxWalletLaunchSettlement(f)).status,'unresolved')
})
for(const [name,mutate]of [
 ['missing inclusion',f=>{f.block.signatures=[]}],['duplicate inclusion',f=>{f.block.signatures.push(f.signature)}],['expired creation slot',f=>{f.transaction.slot=f.review.validUntilSlot+1}],
 ['missing transaction',f=>{f.connections[0].connection.getTransaction=async()=>null}],['unavailable RPC',f=>{f.connections[0].connection.getTransaction=async()=>{throw Error('private-token=SECRET')}}],
 ['event omitted',f=>{f.transaction.meta.innerInstructions=[]}],['forged event ancestry',f=>{f.transaction.meta.innerInstructions[0].instructions[1].stackHeight=2}],
 ['changed treasury debit',f=>{f.transaction.meta.postBalances[0]--}],['changed prepared policy',f=>{const p=f.postAccounts.get(f.settlementContext.compilationInput.observations[0].accounts.find(x=>x.account?.dataBase64&&Buffer.from(x.account.dataBase64,'base64').length===85).address);const bytes=Buffer.from(p.dataBase64,'base64');bytes[10]^=1;p.dataBase64=bytes.toString('base64')}],
 ['changed launch poststate',f=>{const address=f.expected.events.find(e=>e.name==='LaunchCreated').program;const a=f.expected.accounts.find(a=>a.owner===address&&Buffer.from(a.dataBase64,'base64').length>500);const p=f.postAccounts.get(a.address),bytes=Buffer.from(p.dataBase64,'base64');bytes[10]^=1;p.dataBase64=bytes.toString('base64')}],
 ['different config approval',f=>{f.config.approvalReference+='changed'}],['wrong signature',f=>{f.signature='invalid'}],
])test(`settlement stays unresolved for ${name}`,async()=>{const f=await maxWalletSettlementFixture();mutate(f);assert.equal((await collectMaxWalletLaunchSettlement(f)).status,'unresolved')})
test('two providers disagreeing on immutable transaction metadata creates conflict',async()=>{
 const f=await maxWalletSettlementFixture();f.connections[1].connection.getBlockSignatures=async()=>({...f.block,blockhash:'11111111111111111111111111111111'})
 assert.equal((await collectMaxWalletLaunchSettlement(f)).status,'conflict')
})
