import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createPrivateKey, sign } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import pg from 'pg'
import { createWalletIdentityHandler, walletIdentityQuota } from '../app/lib/hooklab-wallet-identity.mjs'
import { HOOK_MAINNET_GENESIS } from '../src/hooklab-execution-contract.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
const seed=Buffer.alloc(32,5), wallet=Keypair.fromSeed(seed).publicKey.toBase58()
const key=createPrivateKey({ key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8' })
const request=(body,cookie='')=>new Request('https://repo.ing/api/hook-lab/wallet-identity',{method:body?'POST':'GET',headers:{Origin:'https://repo.ing','Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})})
const cookie=(response,name)=>{const match=response.headers.get('set-cookie')?.match(new RegExp(`${name}=([A-Za-z0-9_-]{43})`));assert.ok(match);return `${name}=${match[1]}`}
test('isolated HTTP identity round trip uses real atomic store and fail-closed shared quotas without launch authority',async()=>{
  const config={host:'127.0.0.1',port:55432,user:'postgres',password:'launchtest',database:'postgres'}
  const admin=new pg.Pool(config),database=`wallet_identity_http_${randomUUID().replaceAll('-','')}`
  let pool
  try{
    await admin.query(`create database ${database}`);pool=new pg.Pool({...config,database})
    for(const name of ['hooklab-wallet-principal-schema.sql','hooklab-wallet-identity-quota-schema.sql'])await pool.query(await readFile(new URL(`../src/${name}`,import.meta.url),'utf8'))
    const handler=createWalletIdentityHandler({env:{HOOK_WALLET_IDENTITY_ENABLED:'true'},configuration:()=>({origin:'https://repo.ing',audience:'general-launcher',genesisHash:HOOK_MAINNET_GENESIS}),database:()=>({query:pool.query.bind(pool),connect:pool.connect.bind(pool),end:async()=>{}})})
    const first=await handler(request({action:'challenge',wallet}));assert.equal(first.status,200)
    const {challenge}=await first.json(),binding=cookie(first,'__Host-hook-wallet-binding')
    const proof={action:'verify',wallet,nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.message),key).toString('base64')}
    const verified=await handler(request(proof,binding));assert.equal(verified.status,200)
    const session=cookie(verified,'__Host-hook-wallet-session'),body=await verified.json()
    assert.equal(body.canLaunch,false);assert.equal(body.executionAuthorized,false);assert.ok(!JSON.stringify(body).includes(session.split('=')[1]))
    assert.equal((await handler(request(proof,binding))).status,401)
    const read=await handler(request(null,session));assert.equal((await read.json()).principal.wallet,wallet)
    assert.equal((await handler(request({action:'logout'},session))).status,200)
    assert.equal((await(await handler(request(null,session))).json()).signedIn,false)
    assert.equal(await walletIdentityQuota(pool,[['bounded-test',2]]),true)
    assert.equal(await walletIdentityQuota(pool,[['bounded-test',2]]),true)
    assert.equal(await walletIdentityQuota(pool,[['bounded-test',2]]),false)
    await pool.query('drop table hook_lab_wallet_request_limits')
    const failed=await handler(request({action:'challenge',wallet}));assert.equal(failed.status,503)
    assert.doesNotMatch(await failed.text(),/relation|postgres|hook_lab_wallet_request_limits/)
  }finally{if(pool)await pool.end();await dropTestDatabase(admin,database);await admin.end()}
})
