import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js'
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
import { lighthouseAssertion } from '../src/trade-canary.mjs'

const databaseUrl = process.env.DATABASE_URL
assert.match(databaseUrl ?? '', /^postgres:\/\/discoverytest@127\.0\.0\.1:55439\/discovery_test$/,
  'Use the dedicated disposable discovery_test database; never the production tunnel')
const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
const connection = new Connection(rpc, 'confirmed')
const pool = new pg.Pool({ connectionString: databaseUrl })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function finalized(signature) {
  for (let i = 0; i < 160; i++) {
    const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (tx) return tx
    await delay(250)
  }
  throw new Error(`Local transaction did not finalize: ${signature}`)
}

test('discovery rewards: canonical enrollment, exact fees, wallet authorization, payout recovery, and graduation', { timeout: 240_000 }, async t => {
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
  let prepared
  await t.test('rejects another wallet; simultaneous preparations reuse one immutable intent', async () => {
    await assert.rejects(claims.prepare({ repoId, wallet: buyer.publicKey.toBase58() }), /wallet that launched/)
    const offers = await Promise.all([claims.prepare({ repoId, wallet }), claims.prepare({ repoId, wallet })])
    assert.equal(offers[0].id, offers[1].id)
    prepared = offers[0]
    const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
    assert.equal(tx.signatures.find(s => s.publicKey.equals(partner.publicKey)).signature, null)
    // Wallets block offers that arrive partially signed: the wallet must be the first signer.
    assert.ok(tx.signatures.every(s => s.signature === null))
    await assert.rejects(claims.submit({ repoId, id: prepared.id, transaction: prepared.transaction }), /Wallet signature/)
    // A wallet-appended Lighthouse assertion passes the offer check. The local validator has no Lighthouse
    // program, so it then stops at simulation, before anything is recorded or broadcast.
    const asserted = Transaction.from(Buffer.from(prepared.transaction, 'base64')).add(lighthouseAssertion(launcher.publicKey))
    asserted.partialSign(launcher)
    await assert.rejects(claims.submit({ repoId, id: prepared.id,
      transaction: asserted.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }), /could not be simulated/)
    assert.equal((await pool.query('select status from discovery_claims where id = $1', [prepared.id])).rows[0].status, 'prepared')
    tx.instructions.push(SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: buyer.publicKey, lamports: 1 }))
    tx.partialSign(launcher)
    await assert.rejects(claims.submit({ repoId, id: prepared.id,
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }), /does not match/)
  })
  await t.test('expired unsigned offer can be replaced without authorizing a payout', async () => {
    // A prepared offer has no partner signature and cannot settle anywhere.
    await pool.query('update discovery_claims set last_valid_block_height = 1 where id = $1', [prepared.id])
    const result = await claims.recover(repoId)
    assert.equal(result.status, 'aborted')
    prepared = await claims.prepare({ repoId, wallet })
  })
  let submitted, beforeCreator, beforePartner
  await t.test('durable signed intent survives a lost broadcast; no new claim can pay around it', async () => {
    // Existing user WSOL must never be closed by a reward claim.
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, launcher.publicKey)
    await sendAndConfirmTransaction(connection, new Transaction().add(createAssociatedTokenAccountInstruction(
      launcher.publicKey, wsol, launcher.publicKey, NATIVE_MINT)), [launcher])
    const state = await dbc.state.getPool(market.pool)
    beforeCreator = state.poolState.creatorQuoteFee.toString()
    beforePartner = BigInt(state.poolState.partnerQuoteFee.toString())
    const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
    tx.partialSign(launcher)
    const losingConnection = new Proxy(connection, { get(target, key) {
      if (key === 'sendRawTransaction') return async () => { throw new Error('Simulated connection loss before broadcast') }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
    submitted = await createDiscoveryClaims({ pool, connection: losingConnection, config, partner }).submit({ repoId,
      id: prepared.id, transaction: tx.serialize({ requireAllSignatures: false }).toString('base64') })
    assert.equal(submitted.status, 'pending')
    assert.equal((await claims.prepare({ repoId, wallet })).id, submitted.id)
    const stored = (await pool.query('select * from discovery_claims where id = $1', [prepared.id])).rows[0]
    assert.ok(Transaction.from(Buffer.from(stored.transaction, 'base64')).verifySignatures())
    assert.equal(await connection.getTransaction(submitted.signature, { commitment: 'finalized' }), null)
  })
  await t.test('fresh worker rebroadcasts same signature and records one proven payout', async () => {
    const receiverBefore = await connection.getBalance(launcher.publicKey, 'confirmed')
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
    const result = await restarted.recover(repoId)
    assert.equal(result.status, 'settled')
    assert.equal(result.signature, submitted.signature)
    const receiverAfter = await connection.getBalance(launcher.publicKey, 'confirmed')
    assert.equal(BigInt(receiverAfter - receiverBefore + settledTx.meta.fee), BigInt(prepared.amount))
    const state = await dbc.state.getPool(market.pool)
    assert.equal(state.poolState.creatorQuoteFee.toString(), beforeCreator)
    assert.equal(BigInt(state.poolState.partnerQuoteFee.toString()), beforePartner - BigInt(prepared.amount))
    assert.ok(await connection.getAccountInfo(getAssociatedTokenAddressSync(NATIVE_MINT, launcher.publicKey)))
    assert.equal((await discoverySummary(pool, repoId)).remaining, '0')
    assert.equal((await discoverySummary(pool, repoId)).paid, prepared.amount)
    await assert.rejects(claims.prepare({ repoId, wallet }), /No discovery rewards/)
    assert.equal((await claims.submit({ repoId, id: prepared.id, transaction: '' })).status, 'settled')
    assert.equal(await restarted.recover(repoId), null)
    assert.equal((await pool.query("select count(*)::int as n from discovery_claims where status = 'settled'")).rows[0].n, 1)
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
    const transaction = Transaction.from(Buffer.from(finalOffer.transaction, 'base64'))
    transaction.partialSign(launcher)
    const finalClaim = await claims.submit({ repoId, id: finalOffer.id,
      transaction: transaction.serialize({ requireAllSignatures: false }).toString('base64') })
    await finalized(finalClaim.signature)
    assert.equal((await claims.recover(repoId)).status, 'settled')
    assert.equal((await discoverySummary(pool, repoId)).remaining, '0')
    console.log(JSON.stringify({ repoId, pool: market.pool, launch: market.launchSignature,
      migration: migrationSignature, dammPool: bonding.destination.pool,
      rewardClaims: [submitted.signature, finalClaim.signature], earned: (await discoverySummary(pool, repoId)).earned }))
  })
}).finally(() => pool.end())
