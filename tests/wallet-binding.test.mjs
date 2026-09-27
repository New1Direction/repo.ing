import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { repoBeneficiaries, repoVerifications, repositories, walletBindingChallenges } from '../src/db/schema.mjs'
import { createWalletBinding } from '../src/wallet-binding.mjs'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_bind'
const pool = new pg.Pool({ connectionString: databaseUrl })
const db = drizzle(pool)
const binder = createWalletBinding({ pool })
const repoId = 1384142609n
const userId = 285551516n
let successfulBinding
const wallet = () => {
  const pair = generateKeyPairSync('ed25519')
  const address = new PublicKey(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toBase58()
  return { address, signMessage: message => sign(null, Buffer.from(message, 'utf8'), pair.privateKey) }
}

test.before(async () => {
  await pool.query('truncate wallet_binding_challenges, repo_beneficiaries, repo_verifications, fee_events, markets, repositories restart identity cascade')
  await db.insert(repositories).values({ githubRepoId: repoId, owner: 'New1Direction', name: 'Waternot',
    fullName: 'New1Direction/Waternot', stars: 0, forks: 0, archived: false, githubUpdatedAt: new Date() })
  await db.insert(repoVerifications).values({ githubRepoId: repoId, githubUserId: userId,
    githubLogin: 'New1Direction', permission: 'admin', verifiedAt: new Date() })
})
test.after(async () => { await pool.end() })

test('recently verified admin binds a Solana wallet with a valid signature', async () => {
  const signer = wallet()
  const challenge = await binder.requestChallenge({ githubRepoId: repoId, githubUserId: userId, wallet: signer.address })
  assert.match(challenge.message, /repo\.ing repository beneficiary v1/)
  assert.match(challenge.message, new RegExp(`Repository ID: ${repoId}`))
  assert.match(challenge.message, new RegExp(`Wallet: ${signer.address}`))
  const bound = await binder.bindWallet({ githubRepoId: repoId, githubUserId: userId, wallet: signer.address,
    nonce: challenge.nonce, signature: signer.signMessage(challenge.message) })
  successfulBinding = { githubRepoId: repoId, githubUserId: userId, wallet: signer.address,
    nonce: challenge.nonce, signature: signer.signMessage(challenge.message) }
  assert.equal(bound.githubRepoId, repoId)
  assert.equal(bound.githubUserId, userId)
  assert.equal(bound.wallet, signer.address)
  assert.ok(bound.boundAt instanceof Date)
  assert.equal((await db.select().from(repoBeneficiaries)).length, 1)
  assert.equal((await db.select().from(walletBindingChallenges).where(eq(walletBindingChallenges.nonce, challenge.nonce)))[0].consumedAt instanceof Date, true)
  console.log(JSON.stringify({ githubRepoId: repoId.toString(), githubUserId: userId.toString(),
    githubLogin: 'New1Direction', wallet: bound.wallet, boundAt: bound.boundAt.toISOString() }))
})

test('invalid signature or wrong wallet/repository cannot bind', async () => {
  const signer = wallet()
  const other = wallet()
  const challenge = await binder.requestChallenge({ githubRepoId: repoId, githubUserId: userId, wallet: signer.address })
  const request = { githubRepoId: repoId, githubUserId: userId, wallet: signer.address, nonce: challenge.nonce }
  await assert.rejects(binder.bindWallet({ ...request, signature: Buffer.alloc(64) }), /Invalid Solana wallet signature/)
  await assert.rejects(binder.bindWallet({ ...request, wallet: other.address,
    signature: signer.signMessage(challenge.message) }), /mismatched/)
  await assert.rejects(binder.bindWallet({ ...request, githubRepoId: repoId + 1n,
    signature: signer.signMessage(challenge.message) }), /Recent GitHub admin verification required/)
  assert.equal((await db.select().from(walletBindingChallenges).where(eq(walletBindingChallenges.nonce, challenge.nonce)))[0].consumedAt, null)
})

test('used and expired challenges are rejected', async () => {
  await assert.rejects(binder.bindWallet(successfulBinding), /used/)
  const signer = wallet()
  const request = { githubRepoId: repoId, githubUserId: userId, wallet: signer.address }
  const expired = await binder.requestChallenge(request)
  await db.update(walletBindingChallenges).set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(walletBindingChallenges.nonce, expired.nonce))
  await assert.rejects(binder.bindWallet({ ...request, nonce: expired.nonce,
    signature: signer.signMessage(expired.message) }), /expired/)
})

test('unverified GitHub user cannot request or complete a binding', async () => {
  const signer = wallet()
  await assert.rejects(binder.requestChallenge({ githubRepoId: repoId, githubUserId: 999n,
    wallet: signer.address }), /Recent GitHub admin verification required/)
  const challenge = await binder.requestChallenge({ githubRepoId: repoId, githubUserId: userId, wallet: signer.address })
  await assert.rejects(binder.bindWallet({ githubRepoId: repoId, githubUserId: 999n, wallet: signer.address,
    nonce: challenge.nonce, signature: signer.signMessage(challenge.message) }), /Recent GitHub admin verification required/)
})
