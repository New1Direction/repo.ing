import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import { createCreditsConvert } from '../src/credits-web.mjs'
import { redeemHandoff } from '../src/repo-inference-handoff.mjs'

// "Claim as AI credits" on real PostgreSQL (migration 0065) and a local validator (src/credits-web.mjs). The credit service
// is a stand-in that redeems the real handoff row (PKCE) and, like the credit ledger, credits a quote when a finalized
// transfer of its exact lamports to the treasury carries its reference key.
const url = process.env.CREDITS_WEB_TEST_DATABASE_URL
const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8909'
const HANDOFF = { clientSecret: 'c'.repeat(40), assertionSecret: 'a'.repeat(40) }

function creditService({ pool, connection, treasury }) {
  const sessions = new Map(), quotes = new Map()
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
  const fetchImpl = async (address, init = {}) => {
    const { pathname } = new URL(address), body = init.body ? JSON.parse(init.body) : null
    if (Object.keys(init.headers ?? {}).some(key => key.toLowerCase() === 'origin')) return json({ error: 'Browsers are refused.' }, 403)
    if (pathname === '/sessions') {
      const assertion = await redeemHandoff(pool, { audience: 'repo-inference', code: body.code, codeVerifier: body.code_verifier }, HANDOFF)
      if (!assertion) return json({ note: 'The sign-in was already used.' })
      const token = `ses_${randomBytes(24).toString('hex')}`
      sessions.set(token, assertion.github_user_id)
      return json({ token, login: assertion.login, expires_at: new Date(Date.now() + 3600_000).toISOString() })
    }
    const user = sessions.get(String(init.headers?.authorization ?? '').replace('Bearer ', ''))
    if (!user) return json({ error: 'Sign in again.' }, 401)
    if (pathname === '/quotes' && init.method === 'POST') {
      if ([...quotes.values()].some(q => q.user === user && q.status === 'awaiting_payment' && q.expires > Date.now())) return json({ error: 'An open quote exists.' }, 409)
      const id = randomUUID(), lamports = Number(body.lamports), reference = Keypair.generate().publicKey.toBase58()
      const quote = { id, user, lamports, reference, status: 'awaiting_payment', expires: Date.now() + 15 * 60_000, credit_micro: Math.floor(lamports * 0.1098) }
      quotes.set(id, quote)
      const sol = (lamports / LAMPORTS_PER_SOL).toFixed(9).replace(/\.?0+$/, '')
      return json({ id, lamports, credit_micro: quote.credit_micro, price_micro_per_sol: 109_800_000, network: 'devnet',
        expires_at: new Date(quote.expires).toISOString(), solana_pay_url: `solana:${treasury}?amount=${sol}&reference=${reference}&label=repo.ing%20AI%20credits` })
    }
    const quote = quotes.get(pathname.split('/')[2])
    if (!quote || quote.user !== user) return json({ error: 'Unknown quote.' }, 404)
    if (quote.review) return json({ id: quote.id, status: 'awaiting_payment', credit_micro: quote.credit_micro, review_pending: true })
    if (quote.status === 'awaiting_payment' && !quote.blind) {
      for (const { signature } of await connection.getSignaturesForAddress(new PublicKey(quote.reference), {}, 'finalized')) {
        const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
        const keys = tx.transaction.message.staticAccountKeys.map(k => k.toBase58()), at = keys.indexOf(treasury)
        if (!tx.meta.err && at >= 0 && tx.meta.postBalances[at] - tx.meta.preBalances[at] === quote.lamports) { quote.status = 'credited'; quote.signature = signature }
      }
    }
    if (quote.status === 'awaiting_payment' && quote.expires <= Date.now()) quote.status = 'expired'
    return json({ id: quote.id, status: quote.status, credit_micro: quote.credit_micro, review_pending: false })
  }
  return { fetchImpl, quotes }
}

// A fresh table, a treasury, a funded payer and a wallet with 0.05 SOL; `steps` with a given connection (to script the chain).
async function world(pool, connection) {
  await pool.query('truncate credit_conversions, auth_handoffs, agent_request_limits')
  const treasury = Keypair.generate().publicKey.toBase58(), payer = Keypair.generate(), poor = Keypair.generate()
  const airdrop = async (key, sol) => {
    const signature = await connection.requestAirdrop(key, sol * LAMPORTS_PER_SOL)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'finalized')
  }
  await airdrop(payer.publicKey, 2); await airdrop(poor.publicKey, 0.05)
  const service = creditService({ pool, connection, treasury })
  const settings = { origin: 'https://credits.test', treasury, network: 'devnet' }
  const state = { admin: true }
  const githubVerifier = { verifyCurrentAuthority: async () => { if (!state.admin) throw Error('not admin'); return { githubLogin: 'octo' } } }
  const stepsWith = chain => createCreditsConvert({ pool, connection: chain, settings, githubVerifier, fetchImpl: service.fetchImpl })
  const signed = (prepared, keypair) => { const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64')); tx.sign(keypair); return tx.serialize().toString('base64') }
  const handoffs = async () => (await pool.query('select count(*)::int as n from auth_handoffs')).rows[0].n
  return { treasury, payer, poor, service, state, steps: stepsWith(connection), stepsWith, signed, handoffs }
}
const services = () => {
  assert.match(url, /^postgres:\/\/[^@]+@127\.0\.0\.1:\d+\/repoing_credits_web_test$/, 'the disposable test database only')
  assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
  return { pool: new pg.Pool({ connectionString: url }), connection: new Connection(rpc, 'confirmed') }
}
const who = { repoId: '77', githubUserId: '42', login: 'octo' }

test('real PostgreSQL + validator: quote, one approved transfer, credited; the refusals around it', { skip: !url, timeout: 240_000 }, async () => {
  const { pool, connection } = services()
  try {
    const { treasury, payer, poor, service, state, steps } = await world(pool, connection)
    let admin = true
    Object.defineProperty(state, 'admin', { get: () => admin })

    // A quote: a live admin check, the handoff approved by repo.ing itself and redeemed once, the quote checked and stored.
    const quoted = await steps.quote({ ...who, lamports: '250000000', current: null })
    assert.equal(quoted.conversion.status, 'quoted')
    assert.equal(quoted.conversion.lamports, '250000000')
    assert.match(quoted.session.token, /^ses_/)
    const handoffs = (await pool.query('select consumed_at, github_repo_id::text as repo, github_user_id::text as "user" from auth_handoffs')).rows
    assert.deepEqual(handoffs.map(h => [Boolean(h.consumed_at), h.repo, h.user]), [[true, '77', '42']])
    await assert.rejects(steps.quote({ ...who, lamports: '100000000', current: quoted.session }), /open conversion/)
    admin = false
    await assert.rejects(steps.quote({ ...who, githubUserId: '43', lamports: '100000000', current: null }), error => error.status === 403)
    admin = true
    await assert.rejects(steps.prepare({ id: quoted.conversion.id, githubUserId: '43', payer: payer.publicKey.toBase58() }), /Unknown conversion/)

    // Prepare and sign: only the stored message, by its payer, is accepted; the signature is stored before the broadcast.
    const prepared = await steps.prepare({ id: quoted.conversion.id, githubUserId: '42', payer: payer.publicKey.toBase58() })
    assert.equal(prepared.conversion.status, 'prepared')
    const transaction = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
    const other = Keypair.generate()
    const forged = Transaction.from(Buffer.from(prepared.transaction, 'base64')); forged.feePayer = other.publicKey; forged.sign(other)
    await assert.rejects(steps.submit({ id: quoted.conversion.id, githubUserId: '42', signedTransaction: forged.serialize({ requireAllSignatures: false }).toString('base64') }), /different payment/)
    transaction.sign(payer)
    const before = await connection.getBalance(new PublicKey(treasury))
    const submitted = await steps.submit({ id: quoted.conversion.id, githubUserId: '42', signedTransaction: transaction.serialize().toString('base64') })
    assert.equal(submitted.conversion.status, 'submitted')
    assert.ok(submitted.conversion.signature)
    await assert.rejects(steps.cancel({ id: quoted.conversion.id, githubUserId: '42' }), /cannot be cancelled/)
    await assert.rejects(steps.prepare({ id: quoted.conversion.id, githubUserId: '42', payer: payer.publicKey.toBase58() }), /on its way/)
    await connection.confirmTransaction({ signature: submitted.conversion.signature, blockhash: transaction.recentBlockhash,
      lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight }, 'finalized')
    assert.equal(await connection.getBalance(new PublicKey(treasury)) - before, 250_000_000, 'the treasury got the exact quote')
    const landed = await connection.getTransaction(submitted.conversion.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    const reference = (await pool.query('select reference from credit_conversions where id=$1', [quoted.conversion.id])).rows[0].reference
    const index = landed.transaction.message.staticAccountKeys.findIndex(k => k.toBase58() === reference)
    assert.ok(index > 0 && !landed.transaction.message.isAccountWritable(index) && !landed.transaction.message.isAccountSigner(index), 'the reference is read-only and not a signer')

    // The credit service credits the payment; this row follows, and a new quote opens.
    const status = await steps.status({ ...who, current: quoted.session })
    assert.equal(status.conversion.status, 'credited')
    assert.equal(status.conversion.creditedMicro, String(Math.floor(250_000_000 * 0.1098)))
    const second = await steps.quote({ ...who, lamports: '50000000', current: quoted.session })
    assert.equal((await steps.cancel({ id: second.conversion.id, githubUserId: '42' })).conversion.status, 'cancelled')
    // The credit service keeps its quote open until it ends: a new one waits, with the service's own words.
    await assert.rejects(steps.quote({ ...who, lamports: '1000000000', current: second.session }), /open quote exists/)
    service.quotes.get((await pool.query('select quote_id from credit_conversions where id=$1', [second.conversion.id])).rows[0].quote_id).expires = Date.now() - 1

    // A wallet without the SOL: refused before any quote when the card names it; otherwise its payment fails the
    // simulation, nothing is stored or sent, and the conversion waits for another approval.
    const quotesBefore = service.quotes.size
    await assert.rejects(steps.quote({ ...who, lamports: '1000000000', payer: poor.publicKey.toBase58(), current: second.session }), /holds 0\.05 SOL\. Choose at most 0\.04910412 SOL/)
    assert.equal(service.quotes.size, quotesBefore, 'no quote was asked for')
    const third = await steps.quote({ ...who, lamports: '1000000000', current: second.session })
    const unpaid = await steps.prepare({ id: third.conversion.id, githubUserId: '42', payer: poor.publicKey.toBase58() })
    const poorTx = Transaction.from(Buffer.from(unpaid.transaction, 'base64')); poorTx.sign(poor)
    await assert.rejects(steps.submit({ id: third.conversion.id, githubUserId: '42', signedTransaction: poorTx.serialize().toString('base64') }), /enough SOL.*Nothing was sent/)
    const row = (await pool.query('select status, payment_signature from credit_conversions where id=$1', [third.conversion.id])).rows[0]
    assert.deepEqual([row.status, row.payment_signature], ['prepared', null])

    // An expired quote is closed by the next status check.
    await pool.query(`update credit_conversions set expires_at=now()-interval '1 second' where id=$1`, [third.conversion.id])
    service.quotes.get((await pool.query('select quote_id from credit_conversions where id=$1', [third.conversion.id])).rows[0].quote_id).expires = Date.now() - 1
    assert.equal((await steps.status({ ...who, current: second.session })).conversion.status, 'expired')

    // The table's own rules.
    const insert = (status, extra = '') => pool.query(`insert into credit_conversions(github_repo_id,github_user_id,github_login,quote_id,lamports,credit_micro,
      price_micro_per_sol,reference,network,expires_at,status${extra ? ',payment_signature' : ''}) values(77,44,'x',$1,10000000,1,1,'r','devnet',now(),$2${extra ? ',$3' : ''})`,
    extra ? [randomUUID(), status, extra] : [randomUUID(), status])
    await assert.rejects(insert('paid'), /credit_conversions_status_check/)
    await assert.rejects(insert('credited'), /credit_conversions_credited_check/)
    await assert.rejects(insert('submitted', 'sig'), /credit_conversions_payment_check/)
    await insert('quoted')
    await assert.rejects(insert('quoted'), /credit_conversions_one_open/)
  } finally { await pool.end() }
})

test('real PostgreSQL + validator: failed, lost and late payments, review, another repository, no sign-in on a page load', { skip: !url, timeout: 240_000 }, async () => {
  const { pool, connection } = services()
  try {
    const { payer, service, steps, stepsWith, signed, handoffs } = await world(pool, connection)
    const quoteRow = async id => service.quotes.get((await pool.query('select quote_id from credit_conversions where id=$1', [id])).rows[0].quote_id)
    const row = async id => (await pool.query('select status, payment_signature, earlier_signatures from credit_conversions where id=$1', [id])).rows[0]
    // A chain where the payment is never broadcast, and its status is scripted.
    const scripted = (status, height = null) => Object.assign(Object.create(connection), {
      sendRawTransaction: async () => 'not-sent', getSignatureStatuses: async () => ({ value: [status] }),
      ...height === null ? {} : { getBlockHeight: async () => height } })

    // A page load never signs in: an open conversion without a session says so, and nothing is approved.
    const first = await steps.quote({ ...who, lamports: '100000000', current: null })
    const signIns = await handoffs()
    const look = await steps.status({ ...who, current: null })
    assert.deepEqual([look.conversion.status, look.needsSignIn, await handoffs()], ['quoted', true, signIns])
    // A click on Refresh status signs in again (a live admin check) and keeps the new session.
    const checked = await steps.check({ ...who, id: first.conversion.id, current: null })
    assert.equal(await handoffs(), signIns + 1)
    assert.match(checked.session.token, /^ses_/)
    // The open conversion shows on another repository too, and blocks a second quote there.
    const elsewhere = await steps.status({ ...who, repoId: '78', current: checked.session })
    assert.deepEqual([elsewhere.conversion.id, elsewhere.conversion.repoId], [first.conversion.id, '77'])
    await assert.rejects(steps.quote({ ...who, repoId: '78', lamports: '100000000', current: checked.session }), /open conversion/)

    // A payment that landed with an error (the fee spent, nothing paid): its signature is kept and the quote reopens.
    const failing = stepsWith(scripted({ slot: 1, confirmations: null, err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: 'finalized' }))
    const prepared = await failing.prepare({ id: first.conversion.id, githubUserId: '42', payer: payer.publicKey.toBase58() })
    const submitted = await failing.submit({ id: first.conversion.id, githubUserId: '42', signedTransaction: signed(prepared, payer) })
    assert.equal(submitted.conversion.status, 'submitted')
    const reopened = await failing.status({ ...who, current: checked.session })
    assert.equal(reopened.conversion.status, 'prepared')
    assert.deepEqual((await row(first.conversion.id)).earlier_signatures, [submitted.conversion.signature])

    // A payment never found whose blockhash has expired: it can be approved again, or cancelled; one still pending cannot.
    const pending = stepsWith(scripted(null))
    const again = await pending.prepare({ id: first.conversion.id, githubUserId: '42', payer: payer.publicKey.toBase58() })
    await pending.submit({ id: first.conversion.id, githubUserId: '42', signedTransaction: signed(again, payer) })
    await assert.rejects(pending.prepare({ id: first.conversion.id, githubUserId: '42', payer: payer.publicKey.toBase58() }), /on its way/)
    await assert.rejects(pending.cancel({ id: first.conversion.id, githubUserId: '42' }), /on its way/)
    const lost = stepsWith(scripted(null, Number.MAX_SAFE_INTEGER))
    assert.equal((await lost.cancel({ id: first.conversion.id, githubUserId: '42' })).conversion.status, 'cancelled')
    assert.equal((await row(first.conversion.id)).earlier_signatures.length, 2)
    ;(await quoteRow(first.conversion.id)).expires = Date.now() - 1

    // The credit ledger sends a payment to review: the row follows.
    const second = await steps.quote({ ...who, lamports: '100000000', current: checked.session })
    ;(await quoteRow(second.conversion.id)).review = true
    assert.equal((await steps.status({ ...who, current: checked.session })).conversion.status, 'review')
    ;(await quoteRow(second.conversion.id)).expires = Date.now() - 1

    // A payment that lands for a quote the ledger has already closed goes to review, never to "expired".
    const third = await steps.quote({ ...who, lamports: '100000000', current: checked.session })
    const late = await quoteRow(third.conversion.id)
    late.blind = true
    const paid = await steps.prepare({ id: third.conversion.id, githubUserId: '42', payer: payer.publicKey.toBase58() })
    const sent = await steps.submit({ id: third.conversion.id, githubUserId: '42', signedTransaction: signed(paid, payer) })
    for (let i = 0; i < 60 && !(await connection.getSignatureStatuses([sent.conversion.signature])).value[0]; i++) await new Promise(r => setTimeout(r, 500))
    late.expires = Date.now() - 1
    assert.equal((await steps.status({ ...who, current: checked.session })).conversion.status, 'review')

    // Too close to the end: a signed payment is refused, nothing stored.
    const fourth = await steps.quote({ ...who, lamports: '100000000', current: checked.session })
    const close = await steps.prepare({ id: fourth.conversion.id, githubUserId: '42', payer: payer.publicKey.toBase58() })
    await pool.query(`update credit_conversions set expires_at=now()+interval '10 seconds' where id=$1`, [fourth.conversion.id])
    await assert.rejects(steps.submit({ id: fourth.conversion.id, githubUserId: '42', signedTransaction: signed(close, payer) }), /about to expire/)
    assert.deepEqual([(await row(fourth.conversion.id)).status, (await row(fourth.conversion.id)).payment_signature], ['prepared', null])
  } finally { await pool.end() }
})
