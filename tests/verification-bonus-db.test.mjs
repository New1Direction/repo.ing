import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import bs58 from 'bs58'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Connection, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { readVerificationBonusView, readWalletVerificationBonuses } from '../src/verification-bonus.mjs'
import { createVerificationBonusAccrual } from '../src/verification-bonus-accrual.mjs'
import { createVerificationBonusReview } from '../src/verification-bonus-review.mjs'
import { createVerificationBonusPayouts, readCommittedLamports, readProtectedRevenue } from '../src/verification-bonus-payouts.mjs'

// Real PostgreSQL with every committed migration (0047_verification_bonus): new-launch stamping, idempotent accrual
// and every eligibility rule against stored rows, operator review, and the payout intent lifecycle against a scripted
// chain (durable intent before broadcast, idempotent pay, worker rebroadcast, exact-delta settlement, aborts). With a
// local solana-test-validator (CI's full suite), a real payout also lands, settles once and is never paid twice.
const url = process.env.VERIFICATION_BONUS_TEST_DATABASE_URL
const rpc = process.env.SOLANA_RPC_URL
const localRpc = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(rpc ?? '')
const DAY = 86_400_000
const AMOUNT = 250_000_000n
const FEE = 17_000
const key = () => Keypair.generate().publicKey.toBase58()
const operator = { githubUserId: '285551516', githubLogin: 'operator' }
const creator = key()

function requireDisposableDatabase() {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_verification_bonus_test',
    'Disposable verification bonus test database required')
}

const reset = pool => pool.query(`truncate verification_bonus_payouts, verification_bonuses, wallet_binding_challenges, repo_beneficiaries,
  repo_verifications, trade_events, platform_revenue_allocations, platform_fee_claims, maintainer_opt_outs, markets, repositories
  restart identity cascade`)
const decline = (pool, id) => pool.query(`insert into maintainer_opt_outs(github_repo_id, kind, github_user_id) values ($1, 'decline', 501)`, [id])
const withdraw = (pool, id) => pool.query(`update maintainer_opt_outs set withdrawn_at = now(), withdrawn_by_github_user_id = 501
  where github_repo_id = $1 and withdrawn_at is null`, [id])

// earlyAccess: a contributor early access market (docs/EARLY_ACCESS.md), stamped with its window and hook program.
async function seedMarket(pool, id, { launcher, activatedAt, stamp = AMOUNT, discovery = 2, earlyAccess = false }) {
  await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at)
    values ($1, 'octo', $2, $3, 25, 1, false, now())`, [id, `repo-${id}`, `octo/repo-${id}`])
  await pool.query(`insert into markets(github_repo_id, status, mint, pool, launcher_wallet, creator_wallet, token_name, token_symbol,
      launch_signature, launch_slot, launch_finality, indexed_at, last_verified_at, discovery_version, launch_block_time, verification_bonus_lamports,
      early_access_end, transfer_hook_program)
    values ($1, 'confirmed', $2, $3, $4, $5, 'Repo', 'REPO', $6, 1, 'finalized', now(), now(), $7, $8, $9, $10, $11)`,
  [id, `Mint${id}`, `Pool${id}`, launcher, creator, `Launch${id}`, discovery, activatedAt, stamp === null ? null : String(stamp),
    earlyAccess ? activatedAt : null, earlyAccess ? 'Ew1wqkFkxDADJi7iQnBTqy8fELDDotEeE8uzvg7TL6ep' : null])
}
async function verify(pool, id, { at, userId = 501, login = 'maintainer' }) {
  const { rows: [row] } = await pool.query(`insert into repo_verifications(github_repo_id, github_user_id, github_login, permission, verified_at)
    values ($1, $2, $3, 'admin', $4) returning id`, [id, userId, login, at])
  return row.id
}
let tradeSerial = 0
async function trade(pool, id, { trader, lamports, at, direction = 'buy' }) {
  const sol = String(lamports)
  await pool.query(`insert into trade_events(pool, signature, event_index, slot, traded_at, direction, input_base_units, output_base_units,
      next_sqrt_price, trader) values ($1, $2, 0, 1, $3, $4, $5, $6, '1', $7)`,
  [`Pool${id}`, `Trade${id}-${++tradeSerial}`, at, direction, direction === 'buy' ? sol : '1000', direction === 'sell' ? sol : '1000', trader])
}
async function bindingChallenge(pool, { repoId, userId, wallet }) {
  await pool.query(`insert into wallet_binding_challenges(github_repo_id, github_user_id, wallet, nonce, expires_at, consumed_at)
    values ($1, $2, $3, $4, now() + interval '5 minutes', now())`, [repoId, userId, wallet, randomBytes(24).toString('hex')])
}
const bonusRow = async (pool, id) => (await pool.query('select * from verification_bonuses where github_repo_id = $1', [id])).rows[0]
const payoutRows = async (pool, id) => (await pool.query('select * from verification_bonus_payouts where github_repo_id = $1 order by attempt', [id])).rows

// A scripted chain: every RPC the payout path uses, with finalized receipts built from the exact stored bytes.
function scriptedChain() {
  const state = { genesis: 'local', balance: 10_000_000_000n, blockHeight: 100, slot: 1_000, sends: [], landed: new Map(), statuses: new Map(),
    onSend: null, sendError: null, simulationError: null }
  const connection = {
    rpcEndpoint: 'http://127.0.0.1:8899',
    getGenesisHash: async () => state.genesis,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: state.blockHeight + 150 }),
    getRecentPrioritizationFees: async () => [],
    simulateTransaction: async (_tx, options) => ({ value: { err: options?.sigVerify ? state.simulationError : null, unitsConsumed: 450 } }),
    getFeeForMessage: async () => ({ value: FEE }),
    getBalance: async () => Number(state.balance),
    sendRawTransaction: async raw => {
      state.sends.push(Buffer.from(raw).toString('base64'))
      if (state.onSend) await state.onSend(raw)
      if (state.sendError) throw new Error(state.sendError)
      return 'sent'
    },
    getSignatureStatuses: async signatures => ({ context: { slot: state.slot }, value: signatures.map(signature => state.statuses.get(signature) ?? null) }),
    getTransaction: async signature => state.landed.get(signature) ?? null,
    getBlockHeight: async () => state.blockHeight,
    getSlot: async () => state.slot,
  }
  // Finalizes the stored transaction with the given outcome; balance changes default to the exact intended ones.
  function land(signedTransaction, { err = null, launcherDelta, payerDelta } = {}) {
    const signed = Transaction.from(Buffer.from(signedTransaction, 'base64'))
    const message = signed.compileMessage(), signature = bs58.encode(signed.signature)
    const transfer = SystemInstruction.decodeTransfer(signed.instructions.find(ix => ix.programId.equals(SystemProgram.programId)))
    const amount = BigInt(transfer.lamports)
    const deltas = new Map([[transfer.fromPubkey.toBase58(), payerDelta ?? (err ? -BigInt(FEE) : -(amount + BigInt(FEE)))],
      [transfer.toPubkey.toBase58(), launcherDelta ?? (err ? 0n : amount)]])
    const pre = message.accountKeys.map(() => 5_000_000_000n)
    const post = message.accountKeys.map((account, index) => pre[index] + (deltas.get(account.toBase58()) ?? 0n))
    state.landed.set(signature, { slot: 4_242, meta: { err, fee: FEE, preBalances: pre.map(Number), postBalances: post.map(Number) },
      transaction: { signatures: [signature], message } })
    state.statuses.set(signature, { confirmationStatus: 'finalized', err })
    return signature
  }
  return { connection, state, land }
}

test('real PostgreSQL: verification bonus stamping, accrual, review and payout intents', { skip: !url, timeout: 120_000 }, async t => {
  requireDisposableDatabase()
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await reset(pool)

    await t.test('only new reservations are stamped, from the configured amount; confirmed markets never change', async () => {
      const launcherWallet = key()
      const fakeLauncher = { creatorWallet: creator, submit: async () => {}, inspect: async () => true,
        prepare: async () => ({ mint: key(), pool: key(), blockhash: key(), lastValidBlockHeight: 100n,
          sign: async () => ({ raw: Buffer.from([1]), signature: key() }) }) }
      const github = id => async () => ({ ok: true, status: 200, json: async () => ({ id, name: `bonus-${id}`, full_name: `octo/bonus-${id}`,
        owner: { login: 'octo', avatar_url: null }, description: null, stargazers_count: 20, forks_count: 0, archived: false,
        private: false, visibility: 'public', updated_at: '2026-01-01T00:00:00Z' }) })
      const launch = (id, verificationBonusLamports) => createLaunchCoordinator({ pool, launcher: fakeLauncher, fetchImpl: github(id),
        verificationBonusLamports }).launch({ repositoryUrl: `https://github.com/octo/bonus-${id}`, tokenName: 'Bonus', tokenSymbol: 'BONUS',
        launcherWallet, signTransaction: async tx => tx })
      assert.equal((await launch(9101, AMOUNT)).verificationBonusLamports, AMOUNT)
      assert.equal((await launch(9102, null)).verificationBonusLamports, null)
      assert.equal((await launch(9102, 500_000_000n)).verificationBonusLamports, null, 'never enrolled retroactively')
      assert.equal((await launch(9101, 500_000_000n)).verificationBonusLamports, AMOUNT, 'the stored stamp stays authoritative')
      await assert.rejects(pool.query('update markets set verification_bonus_lamports = 2000000000 where github_repo_id = 9101'),
        error => error.code === '23514')
      // Once indexed, the stamp is immutable: no retroactive enrollment, no withdrawn promise.
      await seedMarket(pool, 9103, { launcher: key(), activatedAt: new Date(), stamp: null })
      await seedMarket(pool, 9104, { launcher: key(), activatedAt: new Date() })
      for (const sql of ['update markets set verification_bonus_lamports = 250000000 where github_repo_id = 9103',
        'update markets set verification_bonus_lamports = null where github_repo_id = 9104',
        'update markets set verification_bonus_lamports = 300000000 where github_repo_id = 9104']) {
        await assert.rejects(pool.query(sql), /Indexed verification bonus policy is immutable/, sql)
      }
      await pool.query('update markets set last_verified_at = now() where github_repo_id in (9103, 9104)')
      await reset(pool)
    })

    const now = Date.now(), activatedAt = new Date(now - 10 * DAY)
    const launchers = {}
    let reads = 0, outage = false
    const readRepository = async repoId => {
      reads++
      if (outage) throw new Error('GitHub repository read failed: HTTP 503')
      return { createdAt: new Date(now - 400 * DAY).toISOString(), stars: repoId === '9304' ? 9 : 42, fullName: `octo/repo-${repoId}`,
        checkedAt: new Date(now).toISOString() }
    }
    // The accrual clock is advanced by hand: retries back off per repository, and the volume rule settles after 2 hours.
    let clock = now
    const accrual = createVerificationBonusAccrual({ pool, readRepository, now: () => clock })
    // An eligible market: verified 8 days after activation; exactly 1 SOL from other wallets in the days before that.
    async function eligibleMarket(id, { activated = activatedAt, verifiedAt = new Date(now - 2 * DAY), userId = 501 } = {}) {
      launchers[id] = key()
      await seedMarket(pool, id, { launcher: launchers[id], activatedAt: activated })
      const verificationId = await verify(pool, id, { at: verifiedAt, userId })
      await trade(pool, id, { trader: key(), lamports: 600_000_000, at: new Date(verifiedAt.getTime() - 3 * DAY) })
      await trade(pool, id, { trader: key(), lamports: 400_000_000, at: new Date(verifiedAt.getTime() - 2 * DAY), direction: 'sell' })
      return verificationId
    }

    await t.test('accrual: the first admin verification of a stamped market creates one bonus, once', async () => {
      const verificationId = await eligibleMarket(9201)
      await verify(pool, 9201, { at: new Date(now - DAY), userId: 502, login: 'second-admin' })
      await trade(pool, 9201, { trader: launchers[9201], lamports: 9_000_000_000, at: new Date(now - 6 * DAY) })
      await trade(pool, 9201, { trader: null, lamports: 7_000_000_000, at: new Date(now - 6 * DAY) })
      await trade(pool, 9201, { trader: key(), lamports: 9_000_000_000, at: new Date(now - DAY) })
      await seedMarket(pool, 9202, { launcher: key(), activatedAt, stamp: null })
      await verify(pool, 9202, { at: new Date(now - 2 * DAY) })
      await seedMarket(pool, 9203, { launcher: key(), activatedAt })
      await verify(pool, 9203, { at: new Date(now - 60_000) })
      // An early access market is decided only where its trades are indexed (EARLY_ACCESS_DBC_CONFIG; docs/EARLY_ACCESS.md): without
      // the setting it is never a candidate and never recorded, so it is evaluated once its volume can be read.
      await seedMarket(pool, 9204, { launcher: key(), activatedAt, earlyAccess: true })
      await verify(pool, 9204, { at: new Date(now - 2 * DAY) })
      assert.deepEqual(await accrual.candidates(), ['9201'], 'unstamped markets, verifications inside the grace period and early access markets wait')
      assert.deepEqual(await accrual.accrue('9204'), { repoId: '9204', status: 'not-enrolled' })
      assert.equal(await bonusRow(pool, 9204), undefined, 'no bonus row: nothing is decided for it yet')
      const withSetting = createVerificationBonusAccrual({ pool, readRepository, now: () => clock, includeEarlyAccess: true })
      assert.deepEqual(await withSetting.candidates(), ['9201', '9204'], 'with the setting it is a candidate like any other')
      assert.deepEqual(await accrual.runOnce(), [{ repoId: '9201', status: 'pending_review' }])
      const bonus = await bonusRow(pool, 9201)
      assert.deepEqual([bonus.status, bonus.amount, bonus.launcher_wallet, bonus.verification_id, bonus.verifier_login, bonus.reason],
        ['pending_review', '250000000', launchers[9201], verificationId, 'maintainer', null])
      assert.equal(bonus.activated_at.getTime(), activatedAt.getTime())
      assert.deepEqual(bonus.evidence.volume, { other: '1000000000', launcher: '9000000000', unattributed: '7000000000' })
      assert.deepEqual([bonus.evidence.repository.stars, bonus.evidence.rulesVersion, bonus.evidence.failures], [42, 1, []])
      assert.deepEqual(await accrual.runOnce(), [], 'decided markets are never re-evaluated')
      assert.equal(reads, 1)
      await eligibleMarket(9205)
      const racing = await Promise.all([accrual.accrue('9205'), accrual.accrue('9205')])
      assert.deepEqual(racing.map(result => result.status).sort(), ['exists', 'pending_review'])
      assert.equal((await pool.query('select count(*)::int as n from verification_bonuses where github_repo_id = 9205')).rows[0].n, 1)
    })

    await t.test('accrual: each failing rule is recorded as ineligible with its reason; GitHub outages are retried', async () => {
      reads = 0
      // Verified 30 days and 1 ms after an activation 40 days ago: past the window (the trades before it still qualify).
      await eligibleMarket(9301, { activated: new Date(now - 40 * DAY), verifiedAt: new Date(now - 10 * DAY + 1) })
      launchers[9302] = key()
      await seedMarket(pool, 9302, { launcher: launchers[9302], activatedAt })
      await verify(pool, 9302, { at: new Date(now - 2 * DAY) })
      await trade(pool, 9302, { trader: key(), lamports: 500_000_000, at: new Date(now - 5 * DAY) })
      await trade(pool, 9302, { trader: null, lamports: 5_000_000_000, at: new Date(now - 5 * DAY) })
      await trade(pool, 9302, { trader: launchers[9302], lamports: 5_000_000_000, at: new Date(now - 5 * DAY) })
      await eligibleMarket(9303, { userId: 777 })
      await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at)
        values (9399, 'octo', 'other', 'octo/other', 1, 0, false, now())`)
      await pool.query('insert into repo_beneficiaries(github_repo_id, github_user_id, wallet) values (9399, 777, $1)', [launchers[9303]])
      await eligibleMarket(9304)
      await eligibleMarket(9305)
      outage = true
      const first = Object.fromEntries((await accrual.runOnce()).map(result => [result.repoId, result]))
      assert.match(first['9301'].reason, /first verified 30\.0 days after launch/)
      assert.match(first['9302'].reason, /Only 0\.5 SOL of curve volume from wallets other than the launcher/)
      assert.match(first['9303'].reason, /verifying maintainer has bound the launcher wallet/)
      assert.deepEqual([first['9304'].status, first['9305'].status], ['deferred', 'deferred'])
      assert.match(first['9305'].error, /HTTP 503/)
      assert.equal(await bonusRow(pool, 9305), undefined, 'an outage leaves no row')
      assert.equal(reads, 2, 'GitHub is read only when the local rules pass')
      outage = false
      assert.deepEqual(await accrual.runOnce(), [], 'a failed read backs off instead of retrying on every pass')
      clock += 2 * 60_000
      const second = Object.fromEntries((await accrual.runOnce()).map(result => [result.repoId, result]))
      assert.deepEqual([second['9304'].status, second['9305'].status], ['ineligible', 'pending_review'])
      assert.match((await bonusRow(pool, 9304)).reason, /has 9 stars \(minimum 10\)/)
      for (const id of [9301, 9302, 9303]) assert.equal((await bonusRow(pool, id)).status, 'ineligible')
      assert.equal((await bonusRow(pool, 9302)).evidence.volume.unattributed, '5000000000', 'unattributed volume is reported, never counted')
      await assert.rejects(pool.query(`update verification_bonuses set reason = null where github_repo_id = 9301`), error => error.code === '23514')
    })

    const review = createVerificationBonusReview({ pool })
    const terms = id => ({ amount: AMOUNT.toString(), wallet: launchers[id] })

    await t.test('review: approval and rejection bind what the operator saw and re-check the wallet link', async () => {
      await assert.rejects(review.approve({ repoId: '9201', operator, expected: { ...terms(9201), amount: '1' } }), /changed since it was displayed/)
      await assert.rejects(review.approve({ repoId: '9301', operator, expected: terms(9301) }), /ineligible cannot become approved/)
      await assert.rejects(review.approve({ repoId: '9999', operator, expected: terms(9201) }), /not found/)
      await assert.rejects(review.approve({ repoId: '9201', operator: {}, expected: terms(9201) }), /Operator identity/)
      await bindingChallenge(pool, { repoId: 9201, userId: 501, wallet: launchers[9201] })
      await assert.rejects(review.approve({ repoId: '9201', operator, expected: terms(9201) }), /self-launch\)\. Reject this bonus instead/)
      await pool.query('delete from wallet_binding_challenges')
      assert.equal((await review.approve({ repoId: '9201', operator, expected: terms(9201) })).status, 'approved')
      const approved = await bonusRow(pool, 9201)
      assert.deepEqual([approved.status, approved.reviewer_github_user_id, approved.reviewer_login], ['approved', '285551516', 'operator'])
      await assert.rejects(review.approve({ repoId: '9201', operator, expected: terms(9201) }), /approved cannot become approved/)
      await assert.rejects(review.reject({ repoId: '9205', operator, reason: 'no', expected: terms(9205) }), /rejection reason/)
      assert.equal((await review.reject({ repoId: '9205', operator, reason: 'Wash trading between two fresh wallets', expected: terms(9205) })).status, 'rejected')
      assert.equal((await bonusRow(pool, 9205)).reason, 'Wash trading between two fresh wallets')
      const { bonuses, checking } = await review.list()
      assert.deepEqual(bonuses.slice(0, 2).map(bonus => [bonus.repoId, bonus.status]), [['9305', 'pending_review'], ['9201', 'approved']])
      // Undecided: the market inside its grace period, and the early access market waiting for step 5 (verified earlier, listed first).
      assert.deepEqual(checking.map(item => item.repoId), ['9204', '9203'])
      const listed = bonuses.find(bonus => bonus.repoId === '9201')
      assert.deepEqual([listed.fullName, listed.curveVolume, listed.verifierLinkedToLauncher], ['octo/repo-9201', '26000000000', false])
      // A pasted payout address naming the launcher wallet is inert for 48 hours, longer than accrual waits; the reviewer
      // still sees it as a link to the launcher.
      await pool.query(`insert into payout_address_requests(github_repo_id, wallet, requested_by_github_user_id, requested_by_login, active_at)
        values (9201, $1, 501, 'maintainer', now())`, [launchers[9201]])
      assert.equal((await review.list()).bonuses.find(bonus => bonus.repoId === '9201').verifierLinkedToLauncher, true)
      await pool.query('delete from payout_address_requests')
      assert.deepEqual((await readVerificationBonusView(pool, '9205')), { amount: '250000000',
        deadline: new Date(activatedAt.getTime() + 30 * DAY).toISOString(), status: 'rejected' }, 'the free-text reason stays private')
      const rejected = await bonusRow(pool, 9205)
      assert.deepEqual([rejected.approved_at, rejected.approver_login, rejected.reviewer_login], [null, null, 'operator'])
    })

    await t.test('payouts: durable intent before broadcast, idempotent pay, worker recovery and exactly one settlement', async () => {
      const partner = Keypair.generate(), chain = scriptedChain(), env = { VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true' }
      const payouts = createVerificationBonusPayouts({ pool, connection: chain.connection, partner, env, submitBroadcastMs: 0 })
      const worker = createVerificationBonusPayouts({ pool, connection: chain.connection })
      const pay = (id, options = {}) => (options.payouts ?? payouts).pay({ repoId: String(id), operator, expected: terms(id) })
      await assert.rejects(pay(9201, { payouts: createVerificationBonusPayouts({ pool, connection: chain.connection, partner, env: {} }) }), /payouts are off/)
      await assert.rejects(pay(9305), /pending review cannot become paid/)
      await assert.rejects(pay(9201, { payouts: createVerificationBonusPayouts({ pool, connection: chain.connection, partner,
        env: { ...env, VERIFICATION_BONUS_MAX_PER_30D_LAMPORTS: String(AMOUNT - 1n) } }) }), /rolling 30-day cap/)
      chain.state.balance = AMOUNT + BigInt(FEE) + 50_000_000n - 1n
      await assert.rejects(pay(9201), /payout signer needs 0\.000000001 SOL more/)
      chain.state.balance = 10_000_000_000n
      chain.state.simulationError = { InstructionError: [2, 'Custom'] }
      await assert.rejects(pay(9201), /could not be simulated/)
      chain.state.simulationError = null
      assert.deepEqual(await payoutRows(pool, 9201), [], 'a refused payout leaves nothing behind')
      assert.equal(chain.state.sends.length, 0)

      let atFirstSend = null
      chain.state.onSend = async () => { atFirstSend ??= (await pool.query('select status, signed_transaction from verification_bonus_payouts')).rows }
      chain.state.sendError = 'node is behind'
      const sent = await pay(9201)
      assert.deepEqual([sent.status, sent.attempt, sent.amount], ['pending', 1, '250000000'])
      assert.deepEqual(atFirstSend, [{ status: 'pending', signed_transaction: chain.state.sends[0] }], 'signed bytes are saved before the first broadcast')
      const [intent] = await payoutRows(pool, 9201)
      assert.deepEqual([intent.signature, intent.wallet, intent.payer, intent.idempotency_key, intent.created_by],
        [sent.signature, launchers[9201], partner.publicKey.toBase58(), 'verification-bonus:v1:9201:1', '285551516:operator'])
      assert.equal(intent.memo, `repo.ing verification-bonus:v1:9201:1 payout ${intent.id} lamports 250000000`)
      assert.deepEqual(await readVerificationBonusView(pool, '9201'), { amount: '250000000',
        deadline: new Date(activatedAt.getTime() + 30 * DAY).toISOString(), status: 'sending', signature: sent.signature })

      const again = await pay(9201)
      assert.deepEqual([again.status, again.signature], ['pending', sent.signature], 'paying again never signs a second payout')
      assert.equal((await payoutRows(pool, 9201)).length, 1)
      await assert.rejects(pool.query(`insert into verification_bonus_payouts(id, github_repo_id, attempt, idempotency_key, wallet, payer, amount,
          memo, status, signature, signed_transaction, last_valid_block_height, created_by)
        values (gen_random_uuid(), 9201, 2, 'verification-bonus:v1:9201:2', $1, $2, 250000000, 'm', 'pending', 'other', 'x', 1, 'test')`,
      [launchers[9201], partner.publicKey.toBase58()]), error => error.code === '23505', 'one live payout per bonus')
      await assert.rejects(review.reject({ repoId: '9201', operator, reason: 'Changed our mind', expected: terms(9201) }), /in flight or settled/)

      chain.state.sendError = null
      assert.deepEqual((await worker.runOnce()).map(result => result.status), ['pending'])
      assert.equal(chain.state.sends.at(-1), chain.state.sends[0], 'recovery rebroadcasts the exact saved bytes')
      chain.land(intent.signed_transaction, { launcherDelta: AMOUNT - 1n })
      assert.deepEqual((await worker.runOnce()).map(result => result.status), ['review'], 'a wrong balance change is never settled')
      assert.equal((await payoutRows(pool, 9201))[0].status, 'pending')
      chain.land(intent.signed_transaction)
      assert.deepEqual((await worker.runOnce()).map(result => result.status), ['settled'])
      assert.deepEqual(await worker.runOnce(), [])
      const [settled] = await payoutRows(pool, 9201), paid = await bonusRow(pool, 9201)
      assert.deepEqual([settled.status, settled.network_fee, settled.slot, paid.status], ['settled', '17000', '4242', 'paid'])
      assert.ok(paid.paid_at)
      const replay = await pay(9201)
      assert.deepEqual([replay.status, replay.signature], ['settled', sent.signature])
      assert.equal((await payoutRows(pool, 9201)).length, 1)
      assert.equal((await readVerificationBonusView(pool, '9201')).status, 'paid')
      assert.equal((await readWalletVerificationBonuses(pool, launchers[9201])).get('9201').signature, sent.signature)
      assert.equal(await readCommittedLamports(pool), AMOUNT)
    })

    await t.test('payouts: failed or provably expired attempts abort and can be paid again; ambiguous ones never abort', async () => {
      const partner = Keypair.generate(), chain = scriptedChain()
      const payouts = createVerificationBonusPayouts({ pool, connection: chain.connection, partner,
        env: { VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true' }, submitBroadcastMs: 0 })
      const worker = createVerificationBonusPayouts({ pool, connection: chain.connection })
      await review.approve({ repoId: '9305', operator, expected: terms(9305) })
      const pay = () => payouts.pay({ repoId: '9305', operator, expected: terms(9305) })
      const first = await pay()
      chain.land((await payoutRows(pool, 9305))[0].signed_transaction, { err: { InstructionError: [2, { Custom: 1 }] } })
      assert.deepEqual((await worker.runOnce()).map(result => result.status), ['aborted'])
      assert.equal((await bonusRow(pool, 9305)).status, 'approved', 'a failed attempt paid nothing; the bonus stays approved')
      const second = await pay()
      assert.deepEqual([second.attempt, second.signature === first.signature], [2, false])
      assert.equal((await payoutRows(pool, 9305))[1].idempotency_key, 'verification-bonus:v1:9305:2')
      chain.state.blockHeight = Number((await payoutRows(pool, 9305))[1].last_valid_block_height) + 1
      assert.deepEqual((await worker.runOnce()).map(result => result.status), ['aborted'])
      assert.match((await payoutRows(pool, 9305))[1].resolution_reason, /Blockhash expired with no transaction/)
      chain.state.blockHeight = 100
      const third = await pay()
      chain.state.statuses.set(third.signature, { confirmationStatus: 'confirmed', err: null })
      chain.state.blockHeight = Number((await payoutRows(pool, 9305))[2].last_valid_block_height) + 1
      assert.deepEqual((await worker.runOnce()).map(result => result.status), ['pending'], 'a confirmed but not finalized payout waits')
      assert.deepEqual((await payoutRows(pool, 9305)).map(row => row.status), ['aborted', 'aborted', 'pending'])
      assert.equal(await readCommittedLamports(pool), 2n * AMOUNT, 'the cap counts settled and in-flight payouts, not aborted ones')

      await eligibleMarket(9306)
      assert.equal((await accrual.accrue('9306')).status, 'pending_review')
      await review.approve({ repoId: '9306', operator, expected: terms(9306) })
      await assert.rejects(createVerificationBonusPayouts({ pool, connection: chain.connection, partner, submitBroadcastMs: 0,
        env: { VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true', VERIFICATION_BONUS_MAX_PER_30D_LAMPORTS: String(2n * AMOUNT) } })
        .pay({ repoId: '9306', operator, expected: terms(9306) }), /rolling 30-day cap/)
      chain.state.blockHeight = 100
      await pool.query('insert into repo_beneficiaries(github_repo_id, github_user_id, wallet) values (9306, 501, $1)', [launchers[9306]])
      await assert.rejects(payouts.pay({ repoId: '9306', operator, expected: terms(9306) }), /self-launch\)\. Reject this bonus instead of paying it/)
      const rejecter = { githubUserId: '42', githubLogin: 'second-operator' }
      assert.equal((await review.reject({ repoId: '9306', operator: rejecter, reason: 'Maintainer bound the launcher wallet', expected: terms(9306) })).status, 'rejected')
      const revoked = await bonusRow(pool, 9306)
      assert.deepEqual([revoked.status, revoked.approver_login, revoked.reviewer_login, Boolean(revoked.approved_at)],
        ['rejected', 'operator', 'second-operator', true], 'a rejection after approval keeps the approver')
    })

    await t.test('accrual: a bonus failing only the volume rule waits for trade indexing before it is decided', async () => {
      clock = now
      launchers[9307] = key()
      await seedMarket(pool, 9307, { launcher: launchers[9307], activatedAt })
      await verify(pool, 9307, { at: new Date(now - 60 * 60_000) })
      await trade(pool, 9307, { trader: key(), lamports: 200_000_000, at: new Date(now - 2 * 60 * 60_000) })
      assert.deepEqual(await accrual.accrue('9307'), { repoId: '9307', status: 'deferred', reason: 'Waiting for trade indexing to settle the volume rule' })
      assert.equal(await bonusRow(pool, 9307), undefined)
      // A trade made before the verification but indexed late now counts.
      await trade(pool, 9307, { trader: key(), lamports: 800_000_000, at: new Date(now - 3 * 60 * 60_000) })
      assert.equal((await accrual.accrue('9307')).status, 'pending_review')
      launchers[9308] = key()
      await seedMarket(pool, 9308, { launcher: launchers[9308], activatedAt })
      await verify(pool, 9308, { at: new Date(now - 60 * 60_000) })
      await trade(pool, 9308, { trader: key(), lamports: 200_000_000, at: new Date(now - 2 * 60 * 60_000) })
      assert.equal((await accrual.accrue('9308')).status, 'deferred')
      clock = now + 2 * 60 * 60_000
      const settled = await accrual.accrue('9308')
      assert.equal(settled.status, 'ineligible')
      assert.match(settled.reason, /Only 0\.2 SOL of curve volume/)
      clock = now
    })

    await t.test('accrual: a stored repository creation date decides the age rule before the live GitHub answer', async () => {
      await eligibleMarket(9312)
      // The GitHub stub says the repository is 400 days old; the stored date (0045) says it was created 5 days before launch.
      await pool.query('update repositories set github_created_at = $2 where github_repo_id = $1', [9312, new Date(activatedAt.getTime() - 5 * DAY)])
      const young = await accrual.accrue('9312')
      assert.equal(young.status, 'ineligible')
      assert.match(young.reason, /created 5\.0 days before launch \(minimum 30 days\)/)
      const { repository } = (await bonusRow(pool, 9312)).evidence
      assert.deepEqual([repository.createdAtSource, repository.stars], ['stored', 42])
      assert.equal((await bonusRow(pool, 9201)).evidence.repository.createdAtSource, 'github', 'no stored date: the live read decides')
    })

    await t.test('payouts: the payer keeps unallocated and undeployed liquidity revenue, and in-flight payouts count as spent', async () => {
      const partner = Keypair.generate(), payer = partner.publicKey.toBase58(), chain = scriptedChain()
      const payouts = createVerificationBonusPayouts({ pool, connection: chain.connection, partner,
        env: { VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true' }, submitBroadcastMs: 0 })
      await review.approve({ repoId: '9307', operator, expected: terms(9307) })
      await pool.query(`insert into platform_fee_claims(github_repo_id, pool, wallet, amount, status, signature, signed_transaction,
          last_valid_block_height, settled_at, phase) values (9201, 'Pool9201', $1, 9800000000, 'settled', 'RevenueClaim1', 'x', 1, now(), 'DAMM')`, [payer])
      assert.deepEqual(await readProtectedRevenue(pool, payer), { unallocated: 9_800_000_000n, liquidity: 0n, total: 9_800_000_000n })
      assert.deepEqual(await readProtectedRevenue(pool, key()), { unallocated: 0n, liquidity: 0n, total: 0n }, 'only revenue this payer received')
      await assert.rejects(payouts.pay({ repoId: '9307', operator, expected: terms(9307) }),
        /payout signer needs 0\.100017 SOL more: .* 9\.8 SOL is unallocated or liquidity revenue/)
      await pool.query(`insert into platform_revenue_allocations(allocation_group, claim_signature, github_repo_id, claimed_amount, buyback_amount,
          liquidity_amount, treasury_amount, policy_version, created_by) values ('g1', 'RevenueClaim1', 9201, 9800000000, 5880000000, 1960000000,
          1960000000, 1, 'test')`)
      assert.deepEqual(await readProtectedRevenue(pool, payer), { unallocated: 0n, liquidity: 1_960_000_000n, total: 1_960_000_000n })
      assert.equal((await payouts.pay({ repoId: '9307', operator, expected: terms(9307) })).status, 'pending')
      await eligibleMarket(9309)
      assert.equal((await accrual.accrue('9309')).status, 'pending_review')
      await review.approve({ repoId: '9309', operator, expected: terms(9309) })
      // Enough for one more bonus only if the payout still in flight were ignored.
      chain.state.balance = AMOUNT + BigInt(FEE) + 50_000_000n + 1_960_000_000n
      await assert.rejects(payouts.pay({ repoId: '9309', operator, expected: terms(9309) }), /needs 0\.25 SOL more: .* 0\.25 SOL is in flight/)
    })

    await t.test('a maintainer who declines the market earns the launcher nothing: accrual, approval and payment all check', async () => {
      // Declining a market records an admin verification; the bonus accrued from it is ineligible.
      await eligibleMarket(9310)
      await decline(pool, 9310)
      const declined = await accrual.accrue('9310')
      assert.deepEqual([declined.status, declined.reason], ['ineligible', 'The maintainer declined this market'])
      assert.equal((await bonusRow(pool, 9310)).evidence.maintainerDecision.kind, 'decline')
      // A decline after accrual blocks approval until it is withdrawn.
      await eligibleMarket(9311)
      assert.equal((await accrual.accrue('9311')).status, 'pending_review')
      await decline(pool, 9311)
      await assert.rejects(review.approve({ repoId: '9311', operator, expected: terms(9311) }), /declined this market\. Reject this bonus instead/)
      assert.equal((await review.list()).bonuses.find(bonus => bonus.repoId === '9311').maintainerDecision, 'decline')
      await withdraw(pool, 9311)
      assert.equal((await review.approve({ repoId: '9311', operator, expected: terms(9311) })).status, 'approved')
      // A decline after approval blocks payment.
      await decline(pool, 9311)
      const payouts = createVerificationBonusPayouts({ pool, connection: scriptedChain().connection, partner: Keypair.generate(),
        env: { VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true' }, submitBroadcastMs: 0 })
      await assert.rejects(payouts.pay({ repoId: '9311', operator, expected: terms(9311) }), /declined this market\. Reject this bonus instead of paying it/)
      assert.deepEqual(await payoutRows(pool, 9311), [])
    })

    await t.test('a held bonus lock makes operator actions refuse promptly and the worker skip, never wait', async () => {
      const holder = await pool.connect()
      try {
        await holder.query(`select pg_advisory_lock(hashtextextended('verification-bonus', 0))`)
        await assert.rejects(review.reject({ repoId: '9309', operator, reason: 'Testing the lock', expected: terms(9309) }),
          error => error.busy === true && /in progress/.test(error.message))
        const worker = createVerificationBonusPayouts({ pool, connection: scriptedChain().connection })
        const results = await worker.runOnce()
        assert.ok(results.length > 0 && results.every(result => result.status === 'busy'), JSON.stringify(results))
      } finally {
        await holder.query(`select pg_advisory_unlock(hashtextextended('verification-bonus', 0))`)
        holder.release()
      }
      assert.equal((await bonusRow(pool, 9309)).status, 'approved')
    })
  } finally { await pool.end() }
})

test('local validator: a real bonus payout lands, settles once with exact balance deltas, and is never paid twice',
  { skip: !url || !localRpc, timeout: 180_000 }, async () => {
    requireDisposableDatabase()
    const pool = new pg.Pool({ connectionString: url })
    const connection = new Connection(rpc, 'confirmed')
    try {
      await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
      await reset(pool)
      const partner = Keypair.generate(), launcher = Keypair.generate().publicKey.toBase58(), now = Date.now()
      const airdrop = await connection.requestAirdrop(partner.publicKey, 2_000_000_000)
      await connection.confirmTransaction({ signature: airdrop, ...await connection.getLatestBlockhash() }, 'confirmed')
      await seedMarket(pool, 9901, { launcher, activatedAt: new Date(now - 10 * DAY) })
      const verificationId = await verify(pool, 9901, { at: new Date(now - 2 * DAY) })
      await pool.query(`insert into verification_bonuses(github_repo_id, status, amount, launcher_wallet, verification_id, verifier_github_user_id,
          verifier_login, verified_at, activated_at, evidence, reviewed_at, reviewer_github_user_id, reviewer_login, approved_at,
          approver_github_user_id, approver_login)
        values (9901, 'approved', $1, $2, $3, 501, 'maintainer', $4, $5, '{}', now(), 285551516, 'operator', now(), 285551516, 'operator')`,
      [AMOUNT.toString(), launcher, verificationId, new Date(now - 2 * DAY), new Date(now - 10 * DAY)])
      const expected = { amount: AMOUNT.toString(), wallet: launcher }
      const payouts = createVerificationBonusPayouts({ pool, connection, partner, env: { VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true' } })
      const sent = await payouts.pay({ repoId: '9901', operator, expected })
      assert.equal(sent.status, 'pending')
      // Recovery needs no key: the worker settles only once the transaction is finalized.
      const worker = createVerificationBonusPayouts({ pool, connection })
      let result = null
      for (let attempt = 0; attempt < 160 && result?.status !== 'settled'; attempt++) {
        result = await worker.recover('9901')
        if (result.status !== 'settled') await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.equal(result.status, 'settled')
      assert.equal(await connection.getBalance(new PublicKey(launcher), 'finalized'), Number(AMOUNT))
      const receipt = await connection.getTransaction(sent.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
      assert.equal(receipt.meta.err, null)
      assert.equal(result.networkFee, String(receipt.meta.fee))
      assert.equal((await bonusRow(pool, 9901)).status, 'paid')
      const replay = await payouts.pay({ repoId: '9901', operator, expected })
      assert.deepEqual([replay.status, replay.signature], ['settled', sent.signature])
      assert.equal((await payoutRows(pool, 9901)).length, 1)
      assert.equal(await connection.getBalance(new PublicKey(launcher), 'finalized'), Number(AMOUNT), 'never paid twice')
    } finally { await pool.end() }
  })
