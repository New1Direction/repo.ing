import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { repositories, repoVerifications, repoBeneficiaries, walletBindingChallenges } from '../src/db/schema.mjs'
import { createWalletBinding } from '../src/wallet-binding.mjs'
const url=new URL(process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:55443/repoing_builders')
assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/repoing_builders','Disposable local test database required')
const pool=new pg.Pool({connectionString:url.toString()}),db=drizzle(pool),binder=createWalletBinding({pool})
const key=generateKeyPairSync('ed25519'),wallet=new PublicKey(key.publicKey.export({format:'der',type:'spki'}).subarray(-32)).toBase58()
const signMessage=message=>sign(null,Buffer.from(message),key.privateKey)
const request={githubRepoIds:['1002','1001'],githubUserId:'42',wallet}
let challenge

test.before(async()=>{
 await pool.query('truncate repositories cascade')
 for(const id of [1001n,1002n,1003n]){
  await db.insert(repositories).values({githubRepoId:id,owner:'fixture',name:`repo-${id}`,fullName:`fixture/repo-${id}`,stars:0,forks:0,archived:false,githubUpdatedAt:new Date()})
  await db.insert(repoVerifications).values({githubRepoId:id,githubUserId:42n,githubLogin:'fixture',permission:'admin'})
 }
})
test.after(()=>pool.end())
test('one signed message binds two unbound repositories atomically',async()=>{
 challenge=await binder.requestBatchChallenge(request)
 assert.ok(challenge.message.indexOf('Repository ID: 1001')<challenge.message.indexOf('Repository ID: 1002'))
 const signed=signMessage(challenge.message)
 await assert.rejects(binder.bindBatch({nonces:[challenge.nonces[0]],githubUserId:'42',wallet,signature:signed}),/signature/)
 await assert.rejects(binder.bindBatch({nonces:challenge.nonces,githubUserId:'43',wallet,signature:signed}),/mismatched/)
 assert.equal((await db.select().from(repoBeneficiaries)).length,0)
 const result=await binder.bindBatch({nonces:challenge.nonces,githubUserId:'42',wallet,signature:signed})
 assert.equal(result.count,2);assert.equal((await db.select().from(repoBeneficiaries)).length,2)
 await assert.rejects(binder.bindBatch({nonces:challenge.nonces,githubUserId:'42',wallet,signature:signed}),/used/)
 await assert.rejects(binder.requestBatchChallenge(request),/already set/)
})
test('expired, stale-authority, and concurrently changed bindings fail without partial changes',async()=>{
 const request3={...request,githubRepoIds:['1003']}
 const c=await binder.requestBatchChallenge(request3),signature=signMessage(c.message)
 await pool.query("update repo_verifications set verified_at=now()-interval '10 minutes' where github_repo_id=1003")
 await assert.rejects(binder.bindBatch({nonces:c.nonces,githubUserId:'42',wallet,signature}),/Recent GitHub/)
 await pool.query('update repo_verifications set verified_at=now() where github_repo_id=1003')
 await pool.query("update wallet_binding_challenges set expires_at=now()-interval '1 second' where github_repo_id=1003")
 await assert.rejects(binder.bindBatch({nonces:c.nonces,githubUserId:'42',wallet,signature}),/expired/)
 const fresh=await binder.requestBatchChallenge(request3)
 await db.insert(repoBeneficiaries).values({githubRepoId:1003n,githubUserId:42n,wallet})
 await assert.rejects(binder.bindBatch({nonces:fresh.nonces,githubUserId:'42',wallet,signature:signMessage(fresh.message)}),/changed/)
 const rows=await db.select().from(walletBindingChallenges)
 assert.ok(rows.filter(row=>row.githubRepoId===1003n).every(row=>row.consumedAt===null))
})
