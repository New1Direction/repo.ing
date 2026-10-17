import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createPrivateKey, sign, createHash } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import pg from 'pg'
import { walletPrincipalStore } from '../src/hooklab-wallet-principal.mjs'
import { HOOK_MAINNET_GENESIS } from '../src/hooklab-execution-contract.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'
const cfg = { enabled: true, origin: 'https://repo.ing', audience: 'general-launcher', genesisHash: HOOK_MAINNET_GENESIS }
const binding = Buffer.alloc(32, 9).toString('base64url')
const seed = Buffer.alloc(32, 5), address = Keypair.fromSeed(seed).publicKey.toBase58()
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
const signature = message => sign(null, Buffer.from(message), privateKey).toString('base64')
const signed = challenge => ({ nonce: challenge.nonce, wallet: address, signature: signature(challenge.message) })
const disabled = value => { for (const key of ['executionAuthorized', 'canSign', 'canSubmit', 'canLaunch']) assert.equal(value[key], false) }

test('wallet identity defaults off before database or token access and rejects insecure scope', async () => {
  const store = walletPrincipalStore({ connect: () => assert.fail('DB'), query: () => assert.fail('DB') }, { ...cfg, enabled: undefined })
  for (const call of [() => store.challenge(address, binding), () => store.verify({}, binding), () => store.resolve(binding), () => store.revoke(binding)]) await assert.rejects(call())
  for (const change of [{ origin: 'http://repo.ing' }, { origin: 'https://repo.ing/path' }, { audience: 'bad\nAudience' }, { githubUserId: '1' }]) assert.throws(() => walletPrincipalStore({}, { ...cfg, ...change }))
})

test('wallet-first identity is domain bound, single use, durable, expiring and has no launch authority', async t => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }
  const admin = new pg.Pool(config), database = `wallet_principal_test_${randomUUID().replaceAll('-', '')}`
  let pool
  try {
    await admin.query(`create database ${database}`)
    pool = new pg.Pool({ ...config, database })
    await pool.query(await readFile(new URL('../src/hooklab-wallet-principal-schema.sql', import.meta.url), 'utf8'))
    const store = walletPrincipalStore(pool, cfg)
    await t.test('nonce and exact message bind origin, audience, chain, wallet and browser without GitHub', async () => {
      const challenge = await store.challenge(address, binding); disabled(challenge)
      assert.match(challenge.message, /https:\/\/repo.ing/); assert.match(challenge.message, /general-launcher/)
      assert.match(challenge.message, /No spending/); assert.doesNotMatch(challenge.message, /GitHub/)
      for (const change of [{ origin: 'https://other.invalid' }, { audience: 'other-app' }]) await assert.rejects(walletPrincipalStore(pool, { ...cfg, ...change }).verify(signed(challenge), binding))
      await assert.rejects(store.verify(signed(challenge), Buffer.alloc(32, 8).toString('base64url')))
      await assert.rejects(store.verify({ ...signed(challenge), wallet: Keypair.fromSeed(Buffer.alloc(32, 7)).publicKey.toBase58() }, binding))
      await assert.rejects(store.verify({ ...signed(challenge), signature: signature(challenge.message+'!') }, binding))
      await assert.rejects(store.verify({ ...signed(challenge), approved: true }, binding))
      const session = await store.verify(signed(challenge), binding); disabled(session)
      const principal = await walletPrincipalStore(pool, cfg).resolve(session.sessionToken); disabled(principal)
      assert.equal(principal.kind, 'wallet'); assert.equal(principal.wallet, address)
      await assert.rejects(store.verify(signed(challenge), binding))
      const rows = await pool.query('select * from hook_lab_wallet_sessions')
      assert.equal(rows.rows.length, 1)
      assert.equal(rows.rows[0].token_sha256, createHash('sha256').update(session.sessionToken).digest('hex'))
      assert.ok(!JSON.stringify(rows.rows).includes(session.sessionToken))
      await assert.rejects(walletPrincipalStore(pool, { ...cfg, audience: 'other-app' }).resolve(session.sessionToken))
      await assert.rejects(store.resolve(challenge.nonce)); await assert.rejects(store.resolve(randomUUID()))
      await store.revoke(session.sessionToken); await assert.rejects(store.resolve(session.sessionToken))
    })
    await t.test('concurrent proof consumes once and creates one session', async () => {
      const c = await store.challenge(address, binding)
      const results = await Promise.allSettled([store.verify(signed(c), binding), store.verify(signed(c), binding)])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(results.filter(r => r.status === 'rejected').length, 1)
    })
    await t.test('waiting for a challenge lock does not extend its expiry', async () => {
      const c = await store.challenge(address, binding), lock = await pool.connect()
      try {
        await lock.query('begin')
        await lock.query('select nonce from hook_lab_wallet_challenges where nonce=$1 for update', [c.nonce])
        const attempt = store.verify(signed(c), binding)
        const rejected = assert.rejects(attempt)
        await lock.query("update hook_lab_wallet_challenges set expires_at=clock_timestamp()-interval '1 second' where nonce=$1", [c.nonce])
        await lock.query('commit')
        await rejected
      } finally { lock.release() }
    })
    await t.test('expired challenge, tampered message and expired session fail closed', async () => {
      const c = await store.challenge(address, binding)
      await pool.query("update hook_lab_wallet_challenges set expires_at=clock_timestamp()-interval '1 second' where nonce=$1", [c.nonce])
      await assert.rejects(store.verify(signed(c), binding))
      const d = await store.challenge(address, binding)
      await pool.query("update hook_lab_wallet_challenges set message=message||'changed' where nonce=$1", [d.nonce])
      await assert.rejects(store.verify(signed(d), binding))
      const e = await store.challenge(address, binding), session = await store.verify(signed(e), binding)
      await pool.query("update hook_lab_wallet_sessions set expires_at=clock_timestamp()-interval '1 second'")
      await assert.rejects(store.resolve(session.sessionToken))
    })
  } finally { if (pool) await pool.end(); await dropTestDatabase(admin, database); await admin.end() }
})
