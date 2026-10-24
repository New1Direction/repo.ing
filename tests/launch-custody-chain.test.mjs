import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, MigrationFeeOption, SwapMode, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { MULTISIG_VAULT } from '../src/custody-multisig.mjs'
import { LIGHTHOUSE_PROGRAM } from '../src/launch-wallet-assertions.mjs'
import { readLaunchCustodyHandoff } from '../src/launch-custody.mjs'
import { canonicalDbcSwapEvents } from '../src/trade-evidence.mjs'
import { readBondingStatus } from '../app/lib/bonding-status.mjs'

// Requires a disposable validator with the public Fy2 config fixture and current DBC program.
// No mainnet RPC, funded production signer, or live database is accepted by this test.
const rpc = process.env.SOLANA_RPC_URL
assert.match(rpc ?? '', /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Disposable local validator required')
const connection = new Connection(rpc, 'confirmed')
const config = 'Fy2bhQbNPxLPShPxEuTnYzusWgSpSVEgCZ9cbby32TU7'
const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
const handoffTag = Buffer.from([20, 7, 169, 33, 58, 147, 166, 33])
const isHandoff = ix => ix.programId.toBase58() === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN' && ix.data.equals(handoffTag)
const copy = tx => Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function finalized(signature) {
  for (let n = 0; n < 160; n++) {
    const receipt = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (receipt) { assert.equal(receipt.meta.err, null); return receipt }
    await wait(250)
  }
  throw Error('Local transaction did not finalize')
}

test('recovered ordinary launches atomically hand creator rights to custody, including restored full-metadata first buys', { timeout: 180000 }, async t => {
  const payer = Keypair.generate(), creator = Keypair.generate()
  const airdrop = await connection.requestAirdrop(payer.publicKey, 5_000_000_000)
  await finalized(airdrop)
  const launcher = createMeteoraLauncher({ connection, config, creator, metadataOrigin: 'https://repo.ing' })
  const verify = createLaunchEvidenceVerifier({ connection, config })
  assert.equal(launcher.creatorWallet, MULTISIG_VAULT, 'persist the final custody owner, not the online co-signer')
  for (const initialBuyLamports of ['0', '1000000']) {
    await t.test(`initial buy ${initialBuyLamports}`, async () => {
      const prepared = await launcher.prepare({ launcherWallet: payer.publicKey.toBase58(), initialBuyLamports,
        repoId: '7000000000000000', tokenName: 'R'.repeat(32), tokenSymbol: 'CUSTODYMAX' })
      const tx = prepared.transaction
      assert(tx.serialize({ requireAllSignatures: false }).length <= 1232, 'full metadata fits the legacy packet')
      const asserted = copy(tx).add(new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM),
        keys: [{ pubkey: payer.publicKey, isSigner: false, isWritable: false }],
        data: Buffer.from([5, 0, 2, ...Buffer.alloc(8, 1), 0]) }))
      assert(asserted.serialize({ requireAllSignatures: false }).length <= 1232, 'full metadata plus a wallet assertion fits')
      assert.equal(readLaunchCustodyHandoff(asserted, { ...prepared, launcher: payer.publicKey }).toBase58(), creator.publicKey.toBase58())
      const handoffs = tx.instructions.filter(isHandoff)
      assert.equal(handoffs.length, 1)
      assert.equal(handoffs[0].keys[3].pubkey.toBase58(), MULTISIG_VAULT)
      const session = { ...prepared, launcherWallet: payer.publicKey.toBase58(),
        transaction: tx.serialize({ requireAllSignatures: false }).toString('base64') }

      for (const mutation of initialBuyLamports === '0' ? ['missing', 'wrong recipient', 'wrong pool', 'wrong creator', 'before creation', 'duplicate'] : []) {
        const changed = copy(tx), ix = changed.instructions.find(isHandoff)
        if (mutation === 'missing') changed.instructions = changed.instructions.filter(i => !isHandoff(i))
        if (mutation === 'wrong recipient') ix.keys[3].pubkey = payer.publicKey
        if (mutation === 'wrong pool') ix.keys[0].pubkey = Keypair.generate().publicKey
        if (mutation === 'wrong creator') ix.keys[2].pubkey = payer.publicKey
        if (mutation === 'before creation') {
          changed.instructions = [ix, ...changed.instructions.filter(i => i !== ix)]
        }
        if (mutation === 'duplicate') changed.instructions.push(ix)
        assert.throws(() => launcher.restore({ ...session,
          transaction: changed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }),
        /custody handoff/i, mutation)
      }

      // A second process can restore the encrypted session; the wallet signs before server co-signing.
      const replica = createMeteoraLauncher({ connection, config, creator: Keypair.fromSecretKey(creator.secretKey) })
      const restored = replica.restore(session)
      await assert.rejects(restored.sign(async reviewed => {
        const changed = copy(reviewed); changed.instructions.find(isHandoff).keys[3].pubkey = payer.publicKey
        changed.partialSign(payer); return changed
      }), /changed the launch transaction/)
      const walletSigned = await restored.sign(async () => { asserted.partialSign(payer); return asserted })
      assert(Transaction.from(walletSigned.raw).verifySignatures(), 'wallet assertion survives server co-signing')
      const signed = await restored.sign(async reviewed => { const tx = copy(reviewed); tx.partialSign(payer); return tx })
      await replica.submit({ ...signed, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight })
      await finalized(signed.signature)
      const market = { ...prepared, creatorWallet: MULTISIG_VAULT, launcherWallet: payer.publicKey.toBase58(), launchSignature: signed.signature }
      assert.equal((await verify(market)).state, 'match')
      assert(await replica.inspect(market))
      const state = (await dbc.state.getPool(new PublicKey(prepared.pool))).poolState
      assert.equal(state.creator.toBase58(), MULTISIG_VAULT)
      assert.equal((await verify({ ...market, creatorWallet: creator.publicKey.toBase58() })).state, 'mismatch')

      // The online co-signer cannot claw creator rights back after the atomic handoff.
      const steal = await dbc.creator.transferPoolCreator({ pool: new PublicKey(prepared.pool), creator: creator.publicKey,
        newCreator: creator.publicKey })
      await assert.rejects(sendAndConfirmTransaction(connection, steal, [payer, creator], { commitment: 'confirmed', maxRetries: 0 }))
      console.log(JSON.stringify({ initialBuyLamports, wireBytes: signed.raw.length, walletAssertionBytes: walletSigned.raw.length, signature: signed.signature,
        pool: prepared.pool, creator: state.creator.toBase58(), creatorQuoteFee: state.creatorQuoteFee.toString() }))
      if (initialBuyLamports !== '0') {
        const poolKey = new PublicKey(prepared.pool), mintKey = new PublicKey(prepared.mint)
        const send = tx => sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed', maxRetries: 0 })
        const ata = getAssociatedTokenAddressSync(mintKey, payer.publicKey)
        const before = (await getAccount(connection, ata)).amount
        const buy = await send(await dbc.pool.swap({ owner: payer.publicKey, payer: payer.publicKey, pool: poolKey,
          amountIn: new BN(10_000_000), minimumAmountOut: new BN(1), swapBaseForQuote: false, referralTokenAccount: null }))
        const bought = (await getAccount(connection, ata)).amount - before
        assert(bought > 0n)
        const sell = await send(await dbc.pool.swap({ owner: payer.publicKey, payer: payer.publicKey, pool: poolKey,
          amountIn: new BN(bought.toString()), minimumAmountOut: new BN(1), swapBaseForQuote: true, referralTokenAccount: null }))
        assert.equal((await getAccount(connection, ata)).amount, before, 'round trip sells exactly the later buy')
        let creatorFees = 0n
        for (const signature of [signed.signature, buy, sell]) {
          const { events } = canonicalDbcSwapEvents(await finalized(signature), market, new PublicKey(config), dbc)
          assert.equal(events.length, 1)
          creatorFees += BigInt(events[0].data.swapResult.tradingFee.toString()) * 71n / 100n
        }
        assert.equal((await dbc.state.getPool(poolKey)).poolState.creatorQuoteFee.toString(), String(creatorFees))
        // Graduation remains permissionless; the temporary creator is neither the recipient nor a migration signer.
        await finalized(await connection.requestAirdrop(payer.publicKey, 200_000_000_000))
        await finalized(await send(await dbc.pool.swap2({ owner: payer.publicKey, payer: payer.publicKey, pool: poolKey,
          amountIn: new BN(170e9), minimumAmountOut: new BN(1), swapBaseForQuote: false, swapMode: SwapMode.PartialFill, referralTokenAccount: null })))
        assert.equal((await readBondingStatus(connection, market, config)).status, 'migrating')
        await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: 1e9 })))
        const migration = await dbc.migration.migrateToDammV2({ pool: poolKey, payer: payer.publicKey,
          dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100] })
        const migrated = await sendAndConfirmTransaction(connection, migration.transaction,
          [payer, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair], { commitment: 'confirmed', maxRetries: 0 })
        await finalized(migrated)
        assert.equal((await readBondingStatus(connection, market, config)).status, 'graduated')
        assert.equal((await verify(market)).state, 'match', 'finalized creation proof remains valid after graduation')
        assert.equal((await dbc.state.getPool(poolKey)).poolState.creator.toBase58(), MULTISIG_VAULT)
        console.log(JSON.stringify({ roundTripCreatorFees: String(creatorFees), migrated, custody: MULTISIG_VAULT }))
      }
    })
  }
})

test('a later transfer to custody cannot turn a missing or misdirected creation handoff into an accepted receipt', { timeout: 180000 }, async () => {
  const payer = Keypair.generate(), creator = Keypair.generate()
  await finalized(await connection.requestAirdrop(payer.publicKey, 1_000_000_000))
  const launcher = createMeteoraLauncher({ connection, config, creator, metadataOrigin: 'https://repo.ing' })
  const verify = createLaunchEvidenceVerifier({ connection, config })
  for (const defect of ['missing', 'misdirected']) {
    const prepared = await launcher.prepare({ launcherWallet: payer.publicKey.toBase58(), repoId: '123', tokenName: 'Receipt', tokenSymbol: 'RCPT' })
    const tx = copy(prepared.transaction)
    if (defect === 'missing') tx.instructions = tx.instructions.filter(ix => !isHandoff(ix))
    else tx.instructions.find(isHandoff).keys[3].pubkey = payer.publicKey
    // Only disposable keys: deliberately bypass the application's refusal to create a real invalid receipt.
    const signature = await sendAndConfirmTransaction(connection, tx, [payer, creator, Keypair.fromSecretKey(prepared.mintSecretKey)],
      { commitment: 'confirmed', maxRetries: 0 })
    const owner = defect === 'missing' ? creator : payer
    const later = await dbc.creator.transferPoolCreator({ pool: new PublicKey(prepared.pool), creator: owner.publicKey,
      newCreator: new PublicKey(MULTISIG_VAULT) })
    await finalized(await sendAndConfirmTransaction(connection, later, owner === payer ? [payer] : [payer, creator],
      { commitment: 'confirmed', maxRetries: 0 }))
    const market = { ...prepared, creatorWallet: MULTISIG_VAULT, launcherWallet: payer.publicKey.toBase58(), launchSignature: signature }
    assert.equal((await dbc.state.getPool(new PublicKey(prepared.pool))).poolState.creator.toBase58(), MULTISIG_VAULT)
    assert.equal((await verify(market)).state, 'mismatch', defect)
    assert.equal(await launcher.inspect(market), false, defect)
  }
})
