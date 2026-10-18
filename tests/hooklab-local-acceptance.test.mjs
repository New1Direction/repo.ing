import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPublicKey, verify } from 'node:crypto'
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { localAcceptanceNetwork, executionGenesis, assertLocalExecutionEndpoint, LOCAL_PROFILE_SCHEMA } from '../src/hooklab-local-acceptance.mjs'
import { inclusiveMaxWalletProfileSchema, parseMaxWalletProfile } from '../src/hooklab-inclusive-max-wallet-profile.mjs'
import { localHookWalletChoice } from '../app/lib/hooklab-local-wallet.mjs'
const mainnet='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',genesis=new PublicKey(new Uint8Array(32).fill(37)).toBase58()
const environment={NODE_ENV:'development',HOOK_LOCAL_ACCEPTANCE:'true',HOOK_LOCAL_ACCEPTANCE_GENESIS:genesis,
 HOOK_WALLET_IDENTITY_ORIGIN:'https://localhost:3443',HOOK_WALLET_IDENTITY_DATABASE_URL:'postgresql://postgres@127.0.0.1:55432/hooks_local',
 HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY:'https://127.0.0.1:18898',HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY:'https://127.0.0.1:18899',NEXT_PUBLIC_HOOK_LOCAL_TEST_WALLET:'true'}
function setEnvironment(t){const prior=Object.fromEntries(Object.keys(environment).map(key=>[key,process.env[key]]));Object.assign(process.env,environment);t.after(()=>{for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value}})}
test('local execution refuses production, mainnet, remote origins/endpoints and non-disposable databases',()=>{
 assert.equal(localAcceptanceNetwork({}),null);assert.equal(executionGenesis({}),mainnet)
 for(const change of [{NODE_ENV:'production'},{HOOK_LOCAL_ACCEPTANCE_GENESIS:mainnet},{HOOK_WALLET_IDENTITY_ORIGIN:'https://repo.ing'},
  {HOOK_WALLET_IDENTITY_ORIGIN:'http://localhost:3443'},{HOOK_WALLET_IDENTITY_DATABASE_URL:'postgresql://postgres@127.0.0.1/production'},
  {HOOK_WALLET_IDENTITY_DATABASE_URL:'postgresql://postgres@127.0.0.1:55432/hooks_local?host=db.example'},
  {HOOK_WALLET_IDENTITY_DATABASE_URL:'postgresql://postgres@127.0.0.1:55432/hooks_local?database=production'},
  {HOOK_WALLET_IDENTITY_DATABASE_URL:'postgresql://postgres@db.example/hooks_local'},{HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY:'https://api.mainnet-beta.solana.com'},
  {HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY:environment.HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY}])assert.throws(()=>localAcceptanceNetwork({...environment,...change}))
 assert.equal(localAcceptanceNetwork(environment).genesisHash,genesis)
})
test('local profile is a separate gated family; production validators stay mainnet-only',async t=>{
 const profile=JSON.parse(await readFile(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/offline-builder-profile.json',import.meta.url)))
 const local={...profile,schema:LOCAL_PROFILE_SCHEMA,genesisHash:genesis}
 assert.throws(()=>parseMaxWalletProfile(local));assert.throws(()=>inclusiveMaxWalletProfileSchema.parse(local))
 setEnvironment(t)
 assert.equal(parseMaxWalletProfile(local).genesisHash,genesis)
 assert.throws(()=>parseMaxWalletProfile({...local,genesisHash:mainnet}))
 assert.throws(()=>assertLocalExecutionEndpoint('https://api.mainnet-beta.solana.com'))
 assert.throws(()=>assertLocalExecutionEndpoint('https://127.0.0.1:18898/redirect'))
})
test('synthetic wallet signs exact bytes, preserves another signer, and rejects without changing signatures',async t=>{
 setEnvironment(t)
 assert.equal(localHookWalletChoice({location:{hostname:'repo.ing'}}),null)
 let approve=true
 const choice=localHookWalletChoice({location:{hostname:'localhost'},confirm:()=>approve}),provider=choice.legacy
 const {publicKey}=await provider.connect(),other=Keypair.generate(),blockhash=new PublicKey(new Uint8Array(32).fill(51)).toBase58()
 const message=new TransactionMessage({payerKey:publicKey,recentBlockhash:blockhash,instructions:[new TransactionInstruction({programId:other.publicKey,keys:[{pubkey:other.publicKey,isSigner:true,isWritable:false}],data:Buffer.from([7])})]}).compileToV0Message()
 const transaction=new VersionedTransaction(message);transaction.sign([other]);const before=transaction.serialize()
 approve=false
 await assert.rejects(provider.signTransaction(transaction),error=>error.code===4001)
 assert.deepEqual(transaction.serialize(),before)
 approve=true
 const signed=await provider.signTransaction(transaction),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicKey.toBuffer()]),format:'der',type:'spki'})
 assert.equal(verify(null,message.serialize(),key,signed.signatures[0]),true)
 assert.deepEqual(signed.message.serialize(),message.serialize());assert.deepEqual(signed.signatures[1],transaction.signatures[1])
 const text=new TextEncoder().encode('Local identity consent'),signature=await provider.signMessage(text)
 assert.equal(verify(null,text,key,signature),true)
 await provider.disconnect();await assert.rejects(provider.signMessage(text),/Connect the local test wallet/)
})
