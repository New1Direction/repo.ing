import test from 'node:test'
import assert from 'node:assert/strict'
import { sign } from 'node:crypto'
import pg from 'pg'
import bs58 from 'bs58'
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { createCloseAccountInstruction } from '@solana/spl-token'
import { createReferralSponsorship } from '../src/referral-sponsorship.mjs'
import { initializedWsolAccount } from '../src/referral.mjs'
import { createWsolAtaInstruction, wsolAta } from '../src/wsol-account.mjs'

// Free referral payout setup on real PostgreSQL (migration 0063) and a local validator: a wallet with no SOL signs a
// message and gets its payout account from the partner wallet; one free setup per wallet, even after it closes the
// account; unsigned requests hold no place; the day's limit counts signed setups only; expiry, forged seals and other
// wallets' messages; the partner wallet's reserve; the off switch.
const url = process.env.REFERRAL_SPONSOR_TEST_DATABASE_URL
const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8909'
const signMessage = (keypair, message) => bs58.encode(sign(null, Buffer.from(message, 'utf8'), { format: 'der', type: 'pkcs8',
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey.subarray(0, 32))]) }))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('real PostgreSQL + validator: a free referral payout setup paid by the partner wallet, with its limits', { skip: !url, timeout: 180_000 }, async () => {
  assert.match(url, /^postgres:\/\/[^@]+@127\.0\.0\.1:\d+\/repoing_referral_sponsor_test$/, 'the disposable test database only')
  assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
  const pool = new pg.Pool({ connectionString: url })
  const connection = new Connection(rpc, 'confirmed')
  try {
    await pool.query('truncate referral_sponsorships')
    const fund = async (keypair, sol) => {
      const signature = await connection.requestAirdrop(keypair.publicKey, sol * LAMPORTS_PER_SOL)
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
    }
    const sponsor = Keypair.generate(), funder = Keypair.generate()
    await fund(sponsor, 1); await fund(funder, 1)
    const free = createReferralSponsorship({ pool, connection, sponsor, settings: { enabled: true, daily: 2 } })
    const submitFor = (keypair, prepared, extra = {}) => free.submit({ wallet: keypair.publicKey.toBase58(), message: prepared.message,
      seal: prepared.seal, signature: signMessage(keypair, prepared.message), ...extra })
    const wallet = Keypair.generate()

    // A wallet with no SOL at all: free now; it signs a message; the partner wallet creates its account.
    assert.equal(await connection.getBalance(wallet.publicKey), 0)
    assert.equal(await free.available(wallet.publicKey.toBase58()), true)
    const prepared = await free.prepare(wallet.publicKey.toBase58())
    assert.match(prepared.message, new RegExp(`Wallet: ${wallet.publicKey.toBase58()}`))
    assert.match(prepared.message, new RegExp(`Paid by: repo.ing ${sponsor.publicKey.toBase58()}`))
    assert.equal((await pool.query('select count(*)::int as n from referral_sponsorships')).rows[0].n, 0, 'prepare stores nothing')
    // A forged seal, a changed message, a message for another wallet, a wrong signature: refused, nothing stored.
    const stranger = Keypair.generate()
    await assert.rejects(submitFor(wallet, prepared, { seal: 'A'.repeat(43) }), /not issued by repo.ing/)
    const changed = prepared.message.replace('Expires: ', 'Expires: 2')
    await assert.rejects(submitFor(wallet, { ...prepared, message: changed }), /not issued by repo.ing/)
    await assert.rejects(submitFor(stranger, prepared), /for another wallet/)
    await assert.rejects(submitFor(wallet, prepared, { signature: signMessage(stranger, prepared.message) }), /signature does not match/)
    assert.equal((await pool.query('select count(*)::int as n from referral_sponsorships')).rows[0].n, 0)
    const before = BigInt(await connection.getBalance(sponsor.publicKey))
    const result = await submitFor(wallet, prepared)
    assert.equal(result.status, 'settled')
    const account = await initializedWsolAccount(connection, wallet.publicKey)
    assert.ok(account?.address.equals(wsolAta(wallet.publicKey)), 'the payout account exists')
    assert.equal(await connection.getBalance(wallet.publicKey), 0, 'the wallet paid nothing')
    const spent = before - BigInt(await connection.getBalance(sponsor.publicKey))
    assert.ok(spent >= account.lamports && spent < account.lamports + 1_000_000n, `the partner wallet paid the rent and the fee (${spent})`)
    // The row settles from finalized evidence, with what it cost.
    let row
    for (let i = 0; i < 120; i++) {
      await free.recover(wallet.publicKey.toBase58())
      row = (await pool.query('select * from referral_sponsorships where wallet = $1', [wallet.publicKey.toBase58()])).rows[0]
      if (row.status === 'settled') break
      await delay(500)
    }
    assert.equal(row.status, 'settled')
    assert.equal(BigInt(row.rent_lamports) + BigInt(row.fee_lamports), spent)
    assert.deepEqual(await submitFor(wallet, prepared), { status: 'settled', signature: row.signature }, 'a replay sends nothing')
    assert.equal(before - BigInt(await connection.getBalance(sponsor.publicKey)), spent)

    // One free setup per wallet, also after the wallet closes the account and keeps its rent.
    await sendAndConfirmTransaction(connection, new Transaction({ feePayer: funder.publicKey })
      .add(createCloseAccountInstruction(wsolAta(wallet.publicKey), wallet.publicKey, wallet.publicKey)), [funder, wallet], { commitment: 'confirmed' })
    assert.equal(await initializedWsolAccount(connection, wallet.publicKey), null)
    assert.equal(await free.available(wallet.publicKey.toBase58()), false)
    await assert.rejects(free.prepare(wallet.publicKey.toBase58()), /already had its free referral setup/)
    assert.deepEqual(await submitFor(wallet, prepared), { status: 'settled', signature: row.signature }, 'nor through a kept message')

    // Unsigned requests hold no place; the day's limit (2 here) counts signed setups only, checked when they are signed.
    const second = Keypair.generate(), third = Keypair.generate()
    for (let i = 0; i < 5; i++) await free.prepare(Keypair.generate().publicKey.toBase58())
    const forSecond = await free.prepare(second.publicKey.toBase58()), forThird = await free.prepare(third.publicKey.toBase58())
    assert.equal((await submitFor(second, forSecond)).status, 'settled')
    const afterSecond = BigInt(await connection.getBalance(sponsor.publicKey))
    await assert.rejects(submitFor(third, forThird), /used up/)
    assert.equal(BigInt(await connection.getBalance(sponsor.publicKey)), afterSecond, 'nothing sent over the limit')
    assert.equal(await free.available(third.publicKey.toBase58()), false)
    await assert.rejects(free.prepare(third.publicKey.toBase58()), /used up/)

    // An expired message; a wallet that set up its account itself meanwhile: nothing is sent.
    const roomy = createReferralSponsorship({ pool, connection, sponsor, settings: { enabled: true, daily: 50 } })
    const late = createReferralSponsorship({ pool, connection, sponsor, settings: { enabled: true, daily: 50 }, now: () => Date.now() - 10 * 60_000 })
    const old = await late.prepare(third.publicKey.toBase58())
    await assert.rejects(roomy.submit({ wallet: third.publicKey.toBase58(), message: old.message, seal: old.seal, signature: signMessage(third, old.message) }), /expired/)
    const fourth = Keypair.generate(), mine = await roomy.prepare(fourth.publicKey.toBase58())
    await sendAndConfirmTransaction(connection, new Transaction({ feePayer: funder.publicKey }).add(createWsolAtaInstruction(fourth.publicKey, funder.publicKey)), [funder], { commitment: 'confirmed' })
    const paid = BigInt(await connection.getBalance(sponsor.publicKey))
    assert.deepEqual(await roomy.submit({ wallet: fourth.publicKey.toBase58(), message: mine.message, seal: mine.seal, signature: signMessage(fourth, mine.message) }),
      { status: 'settled', alreadyEnabled: true })
    assert.equal(BigInt(await connection.getBalance(sponsor.publicKey)), paid)

    // Concurrent submits of one message: one transaction, one charge. The request that loses the lock can answer before
    // the winner has sent it, so it says 'pending'.
    const fifth = Keypair.generate(), twice = await roomy.prepare(fifth.publicKey.toBase58())
    const args = { wallet: fifth.publicKey.toBase58(), message: twice.message, seal: twice.seal, signature: signMessage(fifth, twice.message) }
    const beforeBoth = BigInt(await connection.getBalance(sponsor.publicKey))
    const both = await Promise.all([roomy.submit(args), roomy.submit(args)])
    assert.ok(both.some(item => item.status === 'settled') && both.every(item => ['settled', 'pending'].includes(item.status)), JSON.stringify(both))
    assert.equal(both[0].signature, both[1].signature, 'the same transaction')
    assert.equal((await pool.query('select count(*)::int as n from referral_sponsorships where wallet = $1', [fifth.publicKey.toBase58()])).rows[0].n, 1)
    const once = beforeBoth - BigInt(await connection.getBalance(sponsor.publicKey))
    assert.ok(once > 0n && once < 3_000_000n, `charged once (${once})`)

    // The partner wallet's reserve and the off switch.
    const poor = Keypair.generate()
    await fund(poor, 0.01)
    const sixth = Keypair.generate().publicKey.toBase58()
    const lean = createReferralSponsorship({ pool, connection, sponsor: poor, settings: { enabled: true, daily: 50 } })
    assert.equal(await lean.available(sixth), false)
    await assert.rejects(lean.prepare(sixth), /not available/)
    const off = createReferralSponsorship({ pool, connection, sponsor, settings: { enabled: false, daily: 50 } })
    assert.equal(await off.available(sixth), false)
    await assert.rejects(off.prepare(sixth), /not available/)
  } finally { await pool.end() }
})
