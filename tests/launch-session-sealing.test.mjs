import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { launchSessionKey, openMintSecret, sealMintSecret } from '../src/launch-sessions.mjs'
import { createMeteoraLauncher, DefinitiveLaunchError } from '../src/meteora-launch.mjs'

// No database or validator: the sealed mint secret and the cross-replica restore of a prepared launch.

test('mint secret is sealed per session: wrong key, session, mint or tampering never opens it', () => {
  const creator = Keypair.generate(), mint = Keypair.generate(), id = randomUUID()
  const key = launchSessionKey(creator.secretKey), ref = { id, mint: mint.publicKey.toBase58() }
  const sealed = sealMintSecret(key, ref, mint.secretKey)
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/)
  for (const plain of [bs58.encode(mint.secretKey), Buffer.from(mint.secretKey).toString('base64'), Buffer.from(mint.secretKey).toString('base64url'),
    Buffer.from(mint.secretKey).toString('hex')]) assert.ok(!sealed.includes(plain))
  assert.notEqual(sealMintSecret(key, ref, mint.secretKey), sealed, 'fresh IV per seal')
  assert.deepEqual(openMintSecret(launchSessionKey(Keypair.fromSecretKey(creator.secretKey).secretKey), ref, sealed), mint.secretKey)
  const expired = /Prepared launch expired/
  assert.throws(() => openMintSecret(launchSessionKey(Keypair.generate().secretKey), ref, sealed), expired)
  assert.throws(() => openMintSecret(key, { ...ref, id: randomUUID() }, sealed), expired)
  assert.throws(() => openMintSecret(key, { ...ref, mint: Keypair.generate().publicKey.toBase58() }, sealed), expired)
  const [v, iv, body, tag] = sealed.split('.')
  const flipped = Buffer.from(body, 'base64url'); flipped[0] ^= 1
  assert.throws(() => openMintSecret(key, ref, [v, iv, flipped.toString('base64url'), tag].join('.')), expired)
  for (const bad of [null, '', 'v1.a.b', `${sealed}.x`, sealed.replace(/^v1/, 'v2')]) assert.throws(() => openMintSecret(key, ref, bad), expired)
  assert.throws(() => launchSessionKey(undefined), /creator key/)
})

function reviewed() {
  const launcher = Keypair.generate(), creator = Keypair.generate(), mint = Keypair.generate()
  const blockhash = Keypair.generate().publicKey.toBase58()
  const tx = new Transaction({ feePayer: launcher.publicKey, recentBlockhash: blockhash })
    .add(SystemProgram.createAccount({ fromPubkey: launcher.publicKey, newAccountPubkey: mint.publicKey,
      lamports: 1461600, space: 82, programId: TOKEN_PROGRAM_ID }))
    .add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: launcher.publicKey, lamports: 1 }))
  // Exactly what the prepare request returns to the wallet and stores in launch_sessions.transaction.
  const transaction = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
  const session = { transaction, mintSecretKey: mint.secretKey, mint: mint.publicKey.toBase58(),
    launcherWallet: launcher.publicKey.toBase58(), blockhash, lastValidBlockHeight: '123' }
  // A different process: only the creator key from the environment and the stored session.
  const otherReplica = createMeteoraLauncher({ connection: new Connection('http://127.0.0.1:1'), config: Keypair.generate().publicKey, creator })
  return { launcher, creator, mint, tx, session, otherReplica }
}

test('a launch reviewed on one replica is co-signed on another from the stored review alone', async () => {
  const { launcher, tx, session, otherReplica } = reviewed()
  const prepared = otherReplica.restore(session)
  assert.equal(prepared.lastValidBlockHeight, 123n)
  const walletSigned = Transaction.from(Buffer.from(session.transaction, 'base64'))
  walletSigned.partialSign(launcher)
  const result = await prepared.sign(async () => Transaction.from(walletSigned.serialize({ requireAllSignatures: false })))
  const final = Transaction.from(result.raw)
  assert.ok(final.verifySignatures())
  assert.deepEqual(final.serializeMessage(), tx.serializeMessage())
  assert.equal(result.signature, bs58.encode(final.signature))
})

test('restore refuses a mismatched key or review, and signing still refuses an altered transaction', async () => {
  const { launcher, session, otherReplica } = reviewed()
  assert.throws(() => otherReplica.restore({ ...session, mintSecretKey: Keypair.generate().secretKey }), DefinitiveLaunchError)
  assert.throws(() => otherReplica.restore({ ...session, launcherWallet: Keypair.generate().publicKey.toBase58() }), DefinitiveLaunchError)
  assert.throws(() => otherReplica.restore({ ...session, blockhash: Keypair.generate().publicKey.toBase58() }), DefinitiveLaunchError)
  const altered = Transaction.from(Buffer.from(session.transaction, 'base64'))
  altered.instructions[1].data[4] ^= 1
  altered.partialSign(launcher)
  await assert.rejects(otherReplica.restore(session).sign(async () => altered), /changed the launch transaction/)
})
