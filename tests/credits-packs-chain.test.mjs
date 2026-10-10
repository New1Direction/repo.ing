import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import { PACK_ODDS, createCreditsPacks } from '../src/credits-packs.mjs'
import { redeemHandoff } from '../src/repo-inference-handoff.mjs'

// AI credit packs on real PostgreSQL (migration 0066) and a local validator (src/credits-packs.mjs). The credit service is
// a stand-in that redeems the real handoff row (PKCE), prices packs like the credit service (the fewest lamports worth the
// pack), replays a quote under the same Idempotency-Key, and, like the credit ledger, credits a pack and spins once when a
// finalized transfer of its exact lamports to the treasury carries its reference key.
const url = process.env.CREDITS_PACKS_TEST_DATABASE_URL
const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8909'
const HANDOFF = { clientSecret: 'c'.repeat(40), assertionSecret: 'a'.repeat(40) }
const PRICE = 109_800_000

function creditService({ pool, connection, treasury }) {
  const sessions = new Map(), quotes = new Map(), keys = new Map()
  const state = { multiplier: 12_000, drop: false, gateway: false, sales: 'sandbox' }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
  const shown = quote => {
    const sol = (quote.lamports / LAMPORTS_PER_SOL).toFixed(9).replace(/\.?0+$/, '')
    return { id: quote.id, kind: 'pack', pack_micro: quote.pack, credit_micro: quote.pack, lamports: quote.lamports, price_micro_per_sol: PRICE, treasury,
      reference: quote.reference, network: 'devnet', status: quote.status, review_pending: Boolean(quote.review), spin: quote.spin ?? null,
      expires_at: new Date(quote.expires).toISOString(), solana_pay_url: `solana:${treasury}?amount=${sol}&reference=${quote.reference}&label=repo.ing%20AI%20credits` }
  }
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
    const token = String(init.headers?.authorization ?? '').replace('Bearer ', ''), user = sessions.get(token)
    if (!user) return json({ error: 'Sign in again.' }, 401)
    if (pathname === '/packs' && init.method !== 'POST') return json({ sales: state.sales, account_room_micro: 240_000_000, policy: { outcomes: PACK_ODDS }, terms: ['One spin per paid pack.'] })
    if (pathname === '/packs') {
      const key = init.headers['idempotency-key']
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(key ?? '')) return json({ error: 'Idempotency-Key is required' }, 400)
      // Like the credit ledger, a retry key belongs to the session (its conversion key) that used it.
      const made = keys.get(`${token}:${key}`)
      if (made) return made.pack === body.pack_micro ? json({ ...shown(made), replayed: true }) : json({ error: 'Idempotency key reused with a different request' }, 409)
      if (state.sales === 'off') return json({ error: 'Credit pack sales are off' }, 503)
      if ([...quotes.values()].some(q => q.user === user && q.status === 'awaiting_payment' && q.expires > Date.now())) return json({ error: 'An open pack quote exists.' }, 409)
      const pack = body.pack_micro, lamports = Number((BigInt(pack) * 1_000_000_000n + BigInt(PRICE) - 1n) / BigInt(PRICE))
      const quote = { id: randomUUID(), user, pack, lamports, reference: Keypair.generate().publicKey.toBase58(), status: 'awaiting_payment', expires: Date.now() + 15 * 60_000 }
      quotes.set(quote.id, quote); keys.set(`${token}:${key}`, quote)
      // The quote is made, but its answer never arrives (a dropped connection), or a gateway answers 502 instead.
      if (state.drop) { state.drop = false; throw new TypeError('fetch failed') }
      if (state.gateway) { state.gateway = false; return new Response('Bad gateway', { status: 502 }) }
      return json(shown(quote))
    }
    const quote = quotes.get(pathname.split('/')[2])
    if (!quote || quote.user !== user) return json({ error: 'Unknown quote.' }, 404)
    if (quote.status === 'awaiting_payment' && !quote.blind && !quote.review) {
      for (const { signature } of await connection.getSignaturesForAddress(new PublicKey(quote.reference), {}, 'finalized')) {
        const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
        const keyList = tx.transaction.message.staticAccountKeys.map(k => k.toBase58()), at = keyList.indexOf(treasury)
        if (!tx.meta.err && at >= 0 && tx.meta.postBalances[at] - tx.meta.preBalances[at] === quote.lamports) {
          quote.status = 'credited'
          quote.spin = { id: randomUUID(), funding_receipt_id: randomUUID(), paid_micro: quote.pack, bonus_micro: quote.pack * (state.multiplier - 10_000) / 10_000,
            multiplier_bps: state.multiplier, plush: false, odds_version: 'sol-pack-v1' }
        }
      }
    }
    if (quote.status === 'awaiting_payment' && quote.expires <= Date.now()) quote.status = 'expired'
    return json(shown(quote))
  }
  return { fetchImpl, quotes, state }
}

// A fresh table, a repository with a market (77) and one without (78), a treasury, a funded payer and a wallet with 0.05
// SOL; `steps` with a given connection (to script the chain).
async function world(pool, connection) {
  await pool.query('truncate credit_pack_purchases, auth_handoffs, agent_request_limits')
  await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values (77,'octo','widget','octo/widget',5,0,false,now()),
    (78,'octo','plain','octo/plain',1,0,false,now()) on conflict do nothing`)
  await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,launch_finality,indexed_at,last_verified_at)
    values (77,'confirmed','MintWidget','PoolWidget','L','C','Widget','WIDGET','Sig',1,'finalized',now(),now()) on conflict do nothing`)
  const treasury = Keypair.generate().publicKey.toBase58(), payer = Keypair.generate(), poor = Keypair.generate()
  const airdrop = async (key, sol) => {
    const signature = await connection.requestAirdrop(key, sol * LAMPORTS_PER_SOL)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'finalized')
  }
  await airdrop(payer.publicKey, 2); await airdrop(poor.publicKey, 0.05)
  const service = creditService({ pool, connection, treasury })
  const settings = { origin: 'https://credits.test', treasury, network: 'devnet' }
  const github = { admin: true, repos: [{ repoId: '78', fullName: 'octo/plain' }, { repoId: '77', fullName: 'octo/widget' }], checked: [] }
  const githubVerifier = {
    listAdminRepositories: async () => github.repos,
    verifyCurrentAuthority: async ({ githubRepoId }) => { github.checked.push(String(githubRepoId)); if (!github.admin) throw Error('not admin'); return { githubLogin: 'octo' } },
  }
  const stepsWith = chain => createCreditsPacks({ pool, connection: chain, settings, githubVerifier, fetchImpl: service.fetchImpl })
  const signed = (prepared, keypair) => { const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64')); tx.sign(keypair); return tx.serialize().toString('base64') }
  const handoffs = async () => (await pool.query('select count(*)::int as n from auth_handoffs')).rows[0].n
  return { treasury, payer, poor, service, github, steps: stepsWith(connection), stepsWith, signed, handoffs }
}
const services = () => {
  assert.match(url, /^postgres:\/\/[^@]+@127\.0\.0\.1:\d+\/repoing_credits_packs_test$/, 'the disposable test database only')
  assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
  return { pool: new pg.Pool({ connectionString: url }), connection: new Connection(rpc, 'confirmed') }
}
const who = { githubUserId: '42', login: 'octo' }
const finalized = async (connection, signature) => {
  for (let i = 0; i < 120; i++) {
    if ((await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]?.confirmationStatus === 'finalized') return
    await new Promise(r => setTimeout(r, 500))
  }
  throw Error('not finalized')
}

test('real PostgreSQL + validator: a $25 pack, one approved transfer, credited with its spin; the refusals around it', { skip: !url, timeout: 240_000 }, async () => {
  const { pool, connection } = services()
  try {
    const { treasury, payer, poor, service, github, steps, signed } = await world(pool, connection)

    // Signed in, the account's offer comes from the credit service; signed out (no session), there is none.
    assert.equal(await steps.offer({ current: null }), null)

    // A quote: a repository with a market among the account's admin repositories, checked live; the handoff approved by
    // repo.ing itself and redeemed once; the pack's quote checked and stored.
    const quoted = await steps.quote({ ...who, packMicro: '25000000', current: null })
    assert.equal(quoted.purchase.status, 'quoted')
    assert.equal(quoted.purchase.lamports, '227686704', 'the fewest lamports worth $25 at $109.80')
    assert.deepEqual(github.checked, ['77'], 'only the repository with a market, checked live')
    const handoffs = (await pool.query('select consumed_at, github_repo_id::text as repo, github_user_id::text as "user" from auth_handoffs')).rows
    assert.deepEqual(handoffs.map(h => [Boolean(h.consumed_at), h.repo, h.user]), [[true, '77', '42']])
    assert.deepEqual(await steps.offer({ current: quoted.session }), { sales: 'sandbox', roomMicro: 240_000_000, odds: PACK_ODDS, terms: ['One spin per paid pack.'] })
    await assert.rejects(steps.quote({ ...who, packMicro: '10000000', current: quoted.session }), /open pack/)
    await assert.rejects(steps.prepare({ id: quoted.purchase.id, githubUserId: '43', payer: payer.publicKey.toBase58() }), /Unknown pack/)
    // No repository with a market, or no admin permission any more: no sign-in.
    github.repos = [{ repoId: '78', fullName: 'octo/plain' }]
    await assert.rejects(steps.quote({ ...who, githubUserId: '43', packMicro: '10000000', current: null }), error => error.status === 403 && /builders/.test(error.message))
    github.repos = [{ repoId: '77', fullName: 'octo/widget' }]; github.admin = false
    await assert.rejects(steps.quote({ ...who, githubUserId: '43', packMicro: '10000000', current: null }), error => error.status === 403)
    github.admin = true

    // A wallet without the SOL for this pack is refused before anything is prepared.
    await assert.rejects(steps.prepare({ id: quoted.purchase.id, githubUserId: '42', payer: poor.publicKey.toBase58() }), /holds 0\.05 SOL\. This pack needs 0\.227691704 SOL/)
    // Prepare and sign: only the stored message, by its payer, is accepted; the signature is stored before the broadcast.
    const prepared = await steps.prepare({ id: quoted.purchase.id, githubUserId: '42', payer: payer.publicKey.toBase58() })
    assert.equal(prepared.purchase.status, 'prepared')
    const other = Keypair.generate()
    const forged = Transaction.from(Buffer.from(prepared.transaction, 'base64')); forged.feePayer = other.publicKey; forged.sign(other)
    await assert.rejects(steps.submit({ id: quoted.purchase.id, githubUserId: '42', signedTransaction: forged.serialize({ requireAllSignatures: false }).toString('base64') }), /different payment/)
    const before = await connection.getBalance(new PublicKey(treasury))
    const submitted = await steps.submit({ id: quoted.purchase.id, githubUserId: '42', signedTransaction: signed(prepared, payer) })
    assert.equal(submitted.purchase.status, 'submitted')
    await assert.rejects(steps.cancel({ id: quoted.purchase.id, githubUserId: '42' }), /cannot be cancelled/)
    await finalized(connection, submitted.purchase.signature)
    assert.equal(await connection.getBalance(new PublicKey(treasury)) - before, 227_686_704, 'the treasury got the exact quote')

    // The credit service credits the pack and spins once: the row keeps the spin, checked against the pack.
    const status = await steps.status({ ...who, current: quoted.session })
    assert.equal(status.purchase.status, 'credited')
    assert.deepEqual({ ...status.purchase.spin, id: 'x' }, { id: 'x', multiplierBps: 12_000, paidMicro: '25000000', bonusMicro: '5000000' })
    const row = (await pool.query('select spin_id, multiplier_bps, bonus_micro::text from credit_pack_purchases where id=$1', [quoted.purchase.id])).rows[0]
    assert.deepEqual([row.spin_id, row.multiplier_bps, row.bonus_micro], [status.purchase.spin.id, 12_000, '5000000'])

    // The table's own rules.
    const insert = (status, extra = {}) => pool.query(`insert into credit_pack_purchases(github_repo_id,github_user_id,github_login,pack_micro,idempotency_key,session_hash,
      network,status,quote_id,lamports,price_micro_per_sol,reference,expires_at,spin_id,multiplier_bps,bonus_micro) values(77,44,'x',$1,$2,repeat('0',64),'devnet',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [extra.pack ?? 25_000_000, randomBytes(8).toString('hex'), status, extra.quote ?? null, extra.lamports ?? null, extra.lamports ? 1 : null, extra.lamports ? 'r' : null,
      extra.lamports ? new Date() : null, extra.spin ?? null, extra.multiplier ?? null, extra.bonus ?? null])
    const quote = { quote: randomUUID(), lamports: 227_686_704 }
    await assert.rejects(insert('paid', quote), /credit_pack_purchases_status_check/)
    await assert.rejects(insert('requested', { pack: 30_000_000 }), /credit_pack_purchases_pack_check/)
    await assert.rejects(insert('quoted'), /credit_pack_purchases_quote_check/)
    await assert.rejects(insert('credited', quote), /credit_pack_purchases_spin_check/)
    await assert.rejects(insert('credited', { ...quote, spin: randomUUID(), multiplier: 12_000, bonus: 6_000_000 }), /credit_pack_purchases_spin_check/)
    await insert('requested')
    await assert.rejects(insert('requested'), /credit_pack_purchases_one_open/)
    service.state.multiplier = 12_000
  } finally { await pool.end() }
})

test('real PostgreSQL + validator: a lost answer, failed and lost payments, review, a refusal, no sign-in on a page load', { skip: !url, timeout: 240_000 }, async () => {
  const { pool, connection } = services()
  try {
    const { payer, service, steps, stepsWith, signed, handoffs } = await world(pool, connection)
    const quoteRow = async id => service.quotes.get((await pool.query('select quote_id from credit_pack_purchases where id=$1', [id])).rows[0].quote_id)
    const row = async id => (await pool.query('select status, payment_signature, earlier_signatures, idempotency_key from credit_pack_purchases where id=$1', [id])).rows[0]
    const scripted = (status, height = null) => Object.assign(Object.create(connection), {
      sendRawTransaction: async () => 'not-sent', getSignatureStatuses: async () => ({ value: [status] }),
      ...height === null ? {} : { getBlockHeight: async () => height } })

    // The quote is made but its answer is lost: the request stays, its new session comes back with the error (for the
    // cookie), and the next click asks again under the same key and session and gets the same quote (not a second one),
    // for the pack first asked for, without a new sign-in.
    service.state.drop = true
    let lost
    await assert.rejects(steps.quote({ ...who, packMicro: '10000000', current: null }), error => { lost = error.session; return error.status === 503 })
    assert.match(lost.token, /^ses_/)
    const [requested] = (await pool.query(`select id, status, idempotency_key from credit_pack_purchases`)).rows
    assert.equal(requested.status, 'requested')
    assert.equal((await steps.status({ ...who, current: null })).purchase.status, 'requested')
    const signInsBefore = await handoffs()
    const again = await steps.quote({ ...who, packMicro: '50000000', current: lost })
    assert.deepEqual([again.purchase.id, again.purchase.status, again.purchase.packMicro], [Number(requested.id), 'quoted', '10000000'])
    assert.equal(again.session, null, 'the session in the cookie stays')
    assert.equal(await handoffs(), signInsBefore, 'no new sign-in')
    assert.equal(service.quotes.size, 1, 'one quote, replayed under the stored key')
    assert.equal((await row(requested.id)).idempotency_key, requested.idempotency_key)

    // A page load never signs in: an open pack without a session says so, and nothing is approved.
    const signIns = await handoffs()
    const look = await steps.status({ ...who, current: null })
    assert.deepEqual([look.purchase.status, look.needsSignIn, await handoffs()], ['quoted', true, signIns])
    const checked = await steps.check({ ...who, id: again.purchase.id, current: null })
    assert.equal(await handoffs(), signIns + 1)

    // A payment that landed with an error (the fee spent, nothing paid): its signature is kept and the quote reopens.
    const failing = stepsWith(scripted({ slot: 1, confirmations: null, err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: 'finalized' }))
    const prepared = await failing.prepare({ id: again.purchase.id, githubUserId: '42', payer: payer.publicKey.toBase58() })
    const submitted = await failing.submit({ id: again.purchase.id, githubUserId: '42', signedTransaction: signed(prepared, payer) })
    assert.equal((await failing.status({ ...who, current: checked.session })).purchase.status, 'prepared')
    assert.deepEqual((await row(again.purchase.id)).earlier_signatures, [submitted.purchase.signature])
    // A payment never found whose blockhash has expired can be cancelled; one still pending cannot.
    const pending = stepsWith(scripted(null))
    const second = await pending.prepare({ id: again.purchase.id, githubUserId: '42', payer: payer.publicKey.toBase58() })
    await pending.submit({ id: again.purchase.id, githubUserId: '42', signedTransaction: signed(second, payer) })
    await assert.rejects(pending.cancel({ id: again.purchase.id, githubUserId: '42' }), /on its way/)
    assert.equal((await stepsWith(scripted(null, Number.MAX_SAFE_INTEGER)).cancel({ id: again.purchase.id, githubUserId: '42' })).purchase.status, 'cancelled')
    ;(await quoteRow(again.purchase.id)).expires = Date.now() - 1

    // The credit ledger sends a payment to review, or credits a pack whose spin does not match it: a review either way.
    const third = await steps.quote({ ...who, packMicro: '10000000', current: checked.session })
    ;(await quoteRow(third.purchase.id)).review = true
    assert.equal((await steps.status({ ...who, current: checked.session })).purchase.status, 'review')
    ;(await quoteRow(third.purchase.id)).expires = Date.now() - 1
    const fourth = await steps.quote({ ...who, packMicro: '10000000', current: checked.session })
    Object.assign(await quoteRow(fourth.purchase.id), { status: 'credited', spin: { id: randomUUID(), paid_micro: 10_000_000, bonus_micro: 9_000_000, multiplier_bps: 20_000 } })
    const odd = await steps.status({ ...who, current: checked.session })
    assert.deepEqual([odd.purchase.status, odd.purchase.spin], ['review', null])

    // A payment that lands for a quote the ledger has already closed goes to review, never to "expired".
    const fifth = await steps.quote({ ...who, packMicro: '10000000', current: checked.session })
    const late = await quoteRow(fifth.purchase.id)
    late.blind = true
    const paid = await steps.prepare({ id: fifth.purchase.id, githubUserId: '42', payer: payer.publicKey.toBase58() })
    const sent = await steps.submit({ id: fifth.purchase.id, githubUserId: '42', signedTransaction: signed(paid, payer) })
    for (let i = 0; i < 60 && !(await connection.getSignatureStatuses([sent.purchase.signature])).value[0]; i++) await new Promise(r => setTimeout(r, 500))
    late.expires = Date.now() - 1
    assert.equal((await steps.status({ ...who, current: checked.session })).purchase.status, 'review')

    // (The quota of 6 quotes in 10 minutes per account is the route's; this test asks for more.)
    await pool.query('truncate agent_request_limits')
    // A gateway's 502 after the quote was made is no refusal: the request stays and is asked again with its session.
    ;(await quoteRow(fifth.purchase.id)).expires = Date.now() - 1
    service.state.gateway = true
    let gateway
    await assert.rejects(steps.quote({ ...who, packMicro: '10000000', current: null }), error => { gateway = error.session; return error.status === 502 })
    assert.equal((await steps.status({ ...who, current: gateway })).purchase.status, 'requested')
    const sixth = await steps.quote({ ...who, packMicro: '10000000', current: gateway })
    assert.equal(sixth.purchase.status, 'quoted')
    await steps.cancel({ id: sixth.purchase.id, githubUserId: '42' })
    // Without that session (the cookie gone), the key is asked under a new one: the first quote is still open there, so
    // the credit service refuses, and that refusal ends the request.
    ;(await quoteRow(sixth.purchase.id)).expires = Date.now() - 1
    service.state.drop = true
    await assert.rejects(steps.quote({ ...who, packMicro: '10000000', current: null }), error => error.status === 503)
    await assert.rejects(steps.quote({ ...who, packMicro: '10000000', current: null }), /open pack quote exists/)
    assert.equal((await steps.status({ ...who, current: null })).purchase.status, 'failed')
    // A refusal from the credit service ends the request at once (nothing to ask again), with the service's words.
    for (const q of service.quotes.values()) q.expires = Date.now() - 1
    service.state.sales = 'off'
    await assert.rejects(steps.quote({ ...who, packMicro: '10000000', current: checked.session }), /sales are off/)
    assert.equal((await steps.status({ ...who, current: checked.session })).purchase.status, 'requested', 'a 503 is no refusal')
    assert.equal((await steps.cancel({ id: (await steps.status({ ...who, current: null })).purchase.id, githubUserId: '42' })).purchase.status, 'cancelled')
  } finally { await pool.end() }
})
