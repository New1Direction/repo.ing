import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { randomUUID, sign } from 'node:crypto'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey, Transaction, SystemInstruction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js'
import { DynamicBondingCurveClient, SwapMode, deriveDbcPoolAuthority, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { NATIVE_MINT, createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createFeeAccrual } from '../src/fee-accrual.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { discoverySummary } from '../src/discovery-rewards.mjs'
import { createDiscoveryClaims } from '../src/discovery-claims.mjs'
import { readBondingStatus } from '../app/lib/bonding-status.mjs'
import { MIN_DISCOVERY_CLAIM_LAMPORTS, discoveryClaimMessage } from '../src/discovery-claim-message.mjs'

const databaseUrl = process.env.DATABASE_URL
assert.match(databaseUrl ?? '', /^postgres:\/\/discoverytest@127\.0\.0\.1:55439\/discovery_test$/,
  'Use the dedicated disposable discovery_test database; never the production tunnel')
const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
const connection = new Connection(rpc, 'confirmed')
const pool = new pg.Pool({ connectionString: databaseUrl })
// What a wallet's signMessage does: a detached ed25519 signature over the UTF-8 bytes.
const signMessage = (keypair, message) => bs58.encode(sign(null, Buffer.from(message, 'utf8'), { format: 'der', type: 'pkcs8',
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey.subarray(0, 32))]) }))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function finalized(signature) {
  for (let i = 0; i < 160; i++) {
    const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (tx) return tx
    await delay(250)
  }
  throw new Error(`Local transaction did not finalize: ${signature}`)
}

test('discovery rewards: canonical enrollment, exact fees, message authorization, server-paid payout recovery, and graduation', { timeout: 240_000 }, async t => {
  await pool.query('truncate repositories restart identity cascade')
  const { config, partner } = await createFixedConfig(connection)
  const nextConfig = (await createFixedConfig(connection, 'balanced')).config
  const previousLegacyConfigs = process.env.DBC_LEGACY_CONFIGS
  process.env.DBC_LEGACY_CONFIGS = config.toBase58()
  t.after(() => {
    if (previousLegacyConfigs === undefined) delete process.env.DBC_LEGACY_CONFIGS
    else process.env.DBC_LEGACY_CONFIGS = previousLegacyConfigs
  })
  const creator = Keypair.generate(), launcher = Keypair.generate(), buyer = Keypair.generate()
  for (const wallet of [launcher, buyer]) {
    const signature = await connection.requestAirdrop(wallet.publicKey, 50_000_000_000)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
  }
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const accrual = createFeeAccrual({ pool, connection, config })
  const trader = createCanonicalTrader({ pool, connection, config })
  // Payouts and recovery must keep working for a legacy market after rotation.
  const claims = createDiscoveryClaims({ pool, connection, config: nextConfig, partner })
  const verify = createLaunchEvidenceVerifier({ connection, config })
  async function launch(repoId, enabled) {
    const coordinator = createLaunchCoordinator({ pool, launcher: createMeteoraLauncher({ connection, config, creator }),
      discoveryEnabled: enabled, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        id: repoId, name: `reward-${repoId}`, full_name: `octocat/reward-${repoId}`, owner: { login: 'octocat' },
        private: false, visibility: 'public', stargazers_count: 1, forks_count: 0, archived: false, updated_at: '2026-01-01T00:00:00Z',
      }) }) })
    const market = await coordinator.launch({ repositoryUrl: `https://github.com/octocat/reward-${repoId}`,
      tokenName: 'Discovery test', tokenSymbol: 'DISC', launcherWallet: launcher.publicKey.toBase58(),
      initialBuyLamports: '10000000', signTransaction: async tx => { tx.partialSign(launcher); return tx } })
    await finalized(market.launchSignature)
    const result = await createLaunchIndexer({ pool, verify }).processMarket(BigInt(repoId))
    assert.equal(result.state, 'indexed')
    await accrual.recordTradeFees({ githubRepoId: repoId, signatures: [market.launchSignature] })
    return market
  }
  const oldMarket = await launch(2001, false)
  const market = await launch(2002, true)
  const repoId = market.githubRepoId.toString()
  const wallet = launcher.publicKey.toBase58()
  const buy = async amount => {
    const prepared = await trader.prepareBuy({ githubRepoId: repoId, wallet: buyer.publicKey.toBase58(), amountLamports: amount })
    const result = await trader.submitTrade(prepared, async tx => { tx.partialSign(buyer); return tx })
    await finalized(result.signature)
    await accrual.recordTradeFees({ githubRepoId: repoId, signatures: [result.signature] })
    return result
  }
  await t.test('existing markets excluded; first buy credited from exact partner split; replay stable', async () => {
    assert.equal(await discoverySummary(pool, oldMarket.githubRepoId), null)
    await assert.rejects(claims.prepare({ repoId: oldMarket.githubRepoId, wallet }), /not enrolled/)
    const state = await dbc.state.getPool(market.pool)
    const expected = BigInt(state.poolState.partnerQuoteFee.toString())
    const before = await discoverySummary(pool, repoId)
    assert.equal(before.partnerEarned, expected.toString())
    assert.equal(before.earned, (expected / 2n).toString())
    assert.ok(BigInt(before.earned) > 0n)
    await accrual.recordTradeFees({ githubRepoId: repoId, signatures: [market.launchSignature, market.launchSignature] })
    assert.equal((await discoverySummary(pool, repoId)).earned, before.earned)
  })
  await t.test('a reward below the claim minimum stays accrued until more fees arrive', async () => {
    assert.ok(BigInt((await discoverySummary(pool, repoId)).remaining) < MIN_DISCOVERY_CLAIM_LAMPORTS)
    await assert.rejects(claims.prepare({ repoId, wallet }), /too small/)
    assert.equal((await pool.query('select count(*)::int as n from discovery_claims')).rows[0].n, 0)
    await buy(2_000_000_000n)
    assert.ok(BigInt((await discoverySummary(pool, repoId)).remaining) >= MIN_DISCOVERY_CLAIM_LAMPORTS)
  })
  let prepared
  const walletSign = (keypair, message) => signMessage(keypair, message)
  const row = async id => (await pool.query('select * from discovery_claims where id = $1', [id])).rows[0]
  await t.test('rejects another wallet; simultaneous preparations reuse one message; the wallet is never sent a transaction', async () => {
    await assert.rejects(claims.prepare({ repoId, wallet: buyer.publicKey.toBase58() }), /wallet that launched/)
    const offers = await Promise.all([claims.prepare({ repoId, wallet }), claims.prepare({ repoId, wallet })])
    assert.equal(offers[0].id, offers[1].id)
    prepared = offers[0]
    assert.equal(prepared.status, 'prepared')
    assert.equal(prepared.transaction, undefined)
    const summary = await discoverySummary(pool, repoId)
    assert.equal(prepared.amount, summary.remaining)
    assert.equal(prepared.message, discoveryClaimMessage({ repoId, market: `octocat/reward-${repoId}`, wallet, amount: prepared.amount,
      claimId: prepared.id, genesis: await connection.getGenesisHash(), expiresAt: prepared.expiresAt }))
    const stored = await row(prepared.id)
    assert.equal(stored.transaction, null)
    assert.equal(stored.auth_message, prepared.message)
    // Wrong wallet, tampered message, garbage and a stale transaction-style submit are all refused before any payout.
    await assert.rejects(claims.submit({ repoId, id: prepared.id, signature: walletSign(buyer, prepared.message) }), /Wallet signature/)
    await assert.rejects(claims.submit({ repoId, id: prepared.id,
      signature: walletSign(launcher, prepared.message.replace(/\d+ lamports/, '2500000000 lamports')) }), /Wallet signature/)
    await assert.rejects(claims.submit({ repoId, id: prepared.id, signature: 'not-a-signature' }), /Wallet signature/)
    await assert.rejects(claims.submit({ repoId, id: prepared.id, transaction: 'AAAA' }), /Reload/)
    await assert.rejects(claims.submit({ repoId, id: 'not-a-claim', signature: walletSign(launcher, prepared.message) }), /not found/)
    const after = await row(prepared.id)
    assert.equal(after.status, 'prepared')
    assert.equal(after.signature, null)
  })
  await t.test('expired confirmation is refused and replaced without a payout', async () => {
    await pool.query("update discovery_claims set auth_expires_at = now() - interval '1 second' where id = $1", [prepared.id])
    await assert.rejects(claims.submit({ repoId, id: prepared.id, signature: walletSign(launcher, prepared.message) }), /expired/)
    assert.equal((await row(prepared.id)).status, 'aborted')
    assert.equal((await row(prepared.id)).transaction, null)
    const next = await claims.prepare({ repoId, wallet })
    assert.notEqual(next.id, prepared.id)
    // The worker also retires an expired, never-signed confirmation.
    await pool.query("update discovery_claims set auth_expires_at = now() - interval '1 second' where id = $1", [next.id])
    assert.equal((await claims.recover(repoId)).status, 'aborted')
  })
  await t.test('legacy transaction-style offers are aborted and replaced by message offers', async () => {
    const legacyTransaction = new Transaction({ feePayer: launcher.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash })
      .add(SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: buyer.publicKey, lamports: 1 }))
      .serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
    const insertLegacy = async () => {
      const id = randomUUID()
      await pool.query(`insert into discovery_claims (id, github_repo_id, wallet, amount, status, transaction, last_valid_block_height)
        values ($1,$2,$3,$4,'prepared',$5,$6)`, [id, repoId, wallet, (await discoverySummary(pool, repoId)).remaining, legacyTransaction, '999999999'])
      return id
    }
    const legacyA = await insertLegacy()
    const replacement = await claims.prepare({ repoId, wallet })
    assert.notEqual(replacement.id, legacyA)
    assert.equal((await row(legacyA)).status, 'aborted')
    assert.match(replacement.message, /does not authorize any transaction/)
    await pool.query("update discovery_claims set status = 'aborted' where id = $1", [replacement.id])
    const legacyB = await insertLegacy()
    await assert.rejects(claims.submit({ repoId, id: legacyB, transaction: legacyTransaction }), /out of date/)
    assert.equal((await row(legacyB)).status, 'aborted')
    prepared = await claims.prepare({ repoId, wallet })
  })
  let submitted, beforeCreator, beforePartnerFee, beforeLauncher, beforePartner
  await t.test('concurrent submits sign one durable payout; a lost broadcast leaves it pending', async () => {
    // Existing user WSOL must never be closed by a reward claim.
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, launcher.publicKey)
    await sendAndConfirmTransaction(connection, new Transaction().add(createAssociatedTokenAccountInstruction(
      launcher.publicKey, wsol, launcher.publicKey, NATIVE_MINT)), [launcher])
    const state = await dbc.state.getPool(market.pool)
    beforeCreator = state.poolState.creatorQuoteFee.toString()
    beforePartnerFee = BigInt(state.poolState.partnerQuoteFee.toString())
    beforeLauncher = BigInt(await connection.getBalance(launcher.publicKey, 'confirmed'))
    beforePartner = BigInt(await connection.getBalance(partner.publicKey, 'confirmed'))
    let sends = 0
    const losingConnection = new Proxy(connection, { get(target, key) {
      if (key === 'sendRawTransaction') return async () => { sends++; throw new Error('Simulated connection loss before broadcast') }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
    const signature = walletSign(launcher, prepared.message)
    const results = await Promise.all([1, 2].map(() => createDiscoveryClaims({ pool, connection: losingConnection, config, partner })
      .submit({ repoId, id: prepared.id, signature })))
    submitted = results[0]
    assert.equal(submitted.status, 'pending')
    assert.equal(results[1].signature, submitted.signature)
    assert.equal(sends, 1, 'only one payout is ever broadcast')
    assert.equal((await claims.prepare({ repoId, wallet })).id, submitted.id)
    const stored = await row(prepared.id)
    assert.equal(stored.auth_signature, signature)
    const tx = Transaction.from(Buffer.from(stored.transaction, 'base64'))
    assert.ok(tx.verifySignatures())
    // Server keys only: the partner pays; the launcher never signs and receives exactly the reward by transfer.
    assert.ok(tx.feePayer.equals(partner.publicKey))
    assert.equal(tx.signatures.length, 2)
    assert.ok(!tx.signatures.some(item => item.publicKey.equals(launcher.publicKey)))
    const toLauncher = tx.instructions.filter(ix => ix.programId.equals(SystemProgram.programId) &&
      SystemInstruction.decodeInstructionType(ix) === 'Transfer').map(ix => SystemInstruction.decodeTransfer(ix))
      .filter(item => item.toPubkey.equals(launcher.publicKey))
    assert.equal(toLauncher.length, 1)
    assert.equal(BigInt(toLauncher[0].lamports), BigInt(prepared.amount))
    assert.equal(await connection.getTransaction(submitted.signature, { commitment: 'finalized' }), null)
    assert.equal((await claims.submit({ repoId, id: prepared.id, signature })).signature, submitted.signature)
  })
  await t.test('fresh worker rebroadcasts the same signature and records one proven payout', async () => {
    const restarted = createDiscoveryClaims({ pool, connection, config })
    const results = await restarted.runOnce()
    assert.equal(results[0].signature, submitted.signature)
    const settledTx = await finalized(submitted.signature)
    assert.equal(settledTx.meta.err, null)
    // Lost/contradictory receipt keeps the intent blocked for review.
    const missingReceipt = new Proxy(connection, { get(target, key) {
      if (key === 'getTransaction') return async () => ({ ...settledTx, meta: { ...settledTx.meta, innerInstructions: [] } })
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
    await assert.rejects(createDiscoveryClaims({ pool, connection: missingReceipt, config }).recover(repoId), /receipt/)
    // A receipt whose balances do not show exactly the reward reaching the launcher is refused too.
    const launcherIndex = settledTx.transaction.message.accountKeys.findIndex(key => key.equals(launcher.publicKey))
    const shortPaid = new Proxy(connection, { get(target, key) {
      if (key === 'getTransaction') return async () => ({ ...settledTx, meta: { ...settledTx.meta,
        postBalances: settledTx.meta.postBalances.map((value, i) => i === launcherIndex ? value - 1 : value) } })
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
    await assert.rejects(createDiscoveryClaims({ pool, connection: shortPaid, config }).recover(repoId), /receipt/)
    const result = await restarted.recover(repoId)
    assert.equal(result.status, 'settled')
    assert.equal(result.signature, submitted.signature)
    const launcherAfter = BigInt(await connection.getBalance(launcher.publicKey, 'finalized'))
    const partnerAfter = BigInt(await connection.getBalance(partner.publicKey, 'finalized'))
    // The launcher gains exactly the reward; the partner pays exactly the network fee and gets every deposit back.
    assert.equal(launcherAfter - beforeLauncher, BigInt(prepared.amount))
    assert.equal(beforePartner - partnerAfter, BigInt(settledTx.meta.fee))
    const state = await dbc.state.getPool(market.pool)
    assert.equal(state.poolState.creatorQuoteFee.toString(), beforeCreator)
    assert.equal(BigInt(state.poolState.partnerQuoteFee.toString()), beforePartnerFee - BigInt(prepared.amount))
    assert.ok(await connection.getAccountInfo(getAssociatedTokenAddressSync(NATIVE_MINT, launcher.publicKey)))
    assert.equal((await discoverySummary(pool, repoId)).remaining, '0')
    assert.equal((await discoverySummary(pool, repoId)).paid, prepared.amount)
    await assert.rejects(claims.prepare({ repoId, wallet }), /No discovery rewards/)
    assert.equal((await claims.submit({ repoId, id: prepared.id, signature: '' })).status, 'settled')
    assert.equal(await restarted.recover(repoId), null)
    assert.equal((await pool.query("select count(*)::int as n from discovery_claims where status = 'settled'")).rows[0].n, 1)
    console.log(JSON.stringify({ payoutLamports: { amount: prepared.amount, networkFee: settledTx.meta.fee,
      launcherDelta: String(launcherAfter - beforeLauncher), partnerDelta: String(partnerAfter - beforePartner),
      signatures: settledTx.transaction.signatures.length } }))
  })
  await t.test('later fees accrue again and graduation stops DBC trading without deleting earned rewards', async () => {
    await buy(10_000_000n)
    // External venues can finish the curve with a partial-fill swap2. Its actual
    // fee event, rather than the requested spend, is what discovery must credit.
    const graduation = await dbc.pool.swap2({ owner: buyer.publicKey, payer: buyer.publicKey,
      pool: market.pool, swapBaseForQuote: false, referralTokenAccount: null,
      swapMode: SwapMode.PartialFill, amountIn: new BN('31000000000'), minimumAmountOut: new BN(1) })
    const graduationSignature = await sendAndConfirmTransaction(connection, graduation, [buyer])
    await finalized(graduationSignature)
    await accrual.recordTradeFees({ githubRepoId: repoId, signatures: [graduationSignature] })
    const state = await dbc.state.getPool(market.pool)
    const fixed = await dbc.state.getPoolConfig(config)
    assert.ok(state.poolState.quoteReserve.gte(fixed.migrationQuoteThreshold))
    assert.ok(BigInt((await discoverySummary(pool, repoId)).remaining) > 0n)
    const earnedBeforeReplay = (await discoverySummary(pool, repoId)).earned
    const indexed = await createExternalFeeIndexer({ pool, connection, config }).runOnce()
    assert.ok(indexed.every(result => result.status === 'OK'))
    assert.equal((await discoverySummary(pool, repoId)).earned, earnedBeforeReplay)
    await assert.rejects(trader.prepareBuy({ githubRepoId: repoId, wallet: buyer.publicKey.toBase58(), amountLamports: 1_000_000n }))
    // Rehearse actual migration, not just reaching the curve's reserve limit.
    // This flash-rent funding is restricted to the disposable local validator.
    const authority = deriveDbcPoolAuthority()
    if (await connection.getBalance(authority) < 1_000_000_000) {
      await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({
        fromPubkey: buyer.publicKey, toPubkey: authority, lamports: 1_000_000_000,
      })), [buyer])
    }
    const migration = await dbc.migration.migrateToDammV2({ payer: buyer.publicKey, pool: new PublicKey(market.pool),
      dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100] })
    const migrationSignature = await sendAndConfirmTransaction(connection, migration.transaction,
      [buyer, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair])
    await finalized(migrationSignature)
    const bonding = await readBondingStatus(connection, market, config)
    assert.equal(bonding.status, 'graduated')
    assert.ok(bonding.destination?.url.startsWith('https://app.meteora.ag/dammv2/'))
    // Earned pre-graduation rewards still have a supported DBC claim path.
    const finalOffer = await claims.prepare({ repoId, wallet })
    const finalClaim = await claims.submit({ repoId, id: finalOffer.id, signature: walletSign(launcher, finalOffer.message) })
    await finalized(finalClaim.signature)
    assert.equal((await claims.recover(repoId)).status, 'settled')
    assert.equal((await discoverySummary(pool, repoId)).remaining, '0')
    console.log(JSON.stringify({ repoId, pool: market.pool, launch: market.launchSignature,
      migration: migrationSignature, dammPool: bonding.destination.pool,
      rewardClaims: [submitted.signature, finalClaim.signature], earned: (await discoverySummary(pool, repoId)).earned }))
  })
}).finally(() => pool.end())
