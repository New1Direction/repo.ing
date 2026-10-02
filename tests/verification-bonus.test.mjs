import test from 'node:test'
import assert from 'node:assert/strict'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { VerificationBonusError, capAllows, evaluateVerificationBonus, failureReason, nextBonusStatus, nextPayoutStatus, payerShortfall,
  rejectionReason, requireReviewedTerms, verificationBonusEnrollment, verificationBonusLamports, verificationBonusPayoutConfig,
  verificationBonusView } from '../src/verification-bonus.mjs'
import { readRepositoryFacts } from '../src/verification-bonus-accrual.mjs'
import { bonusPayoutMemo, checkBonusPayoutShape, createVerificationBonusPayouts, payoutIdempotencyKey } from '../src/verification-bonus-payouts.mjs'
import { usesActivationClock } from '../src/launch-clock.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { verificationBonusCopy, verificationBonusTerms } from '../app/lib/verification-bonus-copy.mjs'

const DAY = 86_400_000
const LAUNCH = Date.parse('2026-10-01T00:00:00Z')
const iso = ms => new Date(ms).toISOString()
// Every rule passing: verified 5 days after launch, a year-old repo with 10 stars, exactly 1 SOL from other wallets.
const facts = (overrides = {}) => ({ activatedAt: new Date(LAUNCH), verifiedAt: new Date(LAUNCH + 5 * DAY), launcherWallet: 'Launcher',
  wallets: { repoPayoutWallet: 'Maintainer', verifierBoundLauncher: false, verifierSignedForLauncher: false },
  volume: { other: '1000000000', launcher: '0', unattributed: '0' }, decision: null,
  repository: { createdAt: iso(LAUNCH - 365 * DAY), stars: 10 }, ...overrides })

test('new launches are stamped only with a valid VERIFICATION_BONUS_LAMPORTS between 0.001 and 1 SOL', () => {
  assert.equal(verificationBonusLamports({}), null)
  assert.deepEqual(verificationBonusEnrollment({ VERIFICATION_BONUS_LAMPORTS: '' }), { lamports: null, error: null })
  assert.equal(verificationBonusLamports({ VERIFICATION_BONUS_LAMPORTS: '250000000' }), 250_000_000n)
  assert.equal(verificationBonusLamports({ VERIFICATION_BONUS_LAMPORTS: ' 1000000000 ' }), 1_000_000_000n)
  for (const bad of ['0', '-1', '0.25', '999999', '1000000001', '2500000000', '0250000000', '1e9', 'abc']) {
    assert.equal(verificationBonusLamports({ VERIFICATION_BONUS_LAMPORTS: bad }), null, bad)
    assert.match(verificationBonusEnrollment({ VERIFICATION_BONUS_LAMPORTS: bad }).error, /not enrolled/, bad)
  }
})

test('payouts ship dark with a 5 SOL rolling cap and a 0.05 SOL payer reserve; malformed limits stop payouts', () => {
  assert.deepEqual(verificationBonusPayoutConfig({}), { enabled: false, cap: 5_000_000_000n, reserve: 50_000_000n, error: null })
  assert.equal(verificationBonusPayoutConfig({ VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true' }).enabled, true)
  for (const value of ['1', 'TRUE', 'yes']) assert.equal(verificationBonusPayoutConfig({ VERIFICATION_BONUS_PAYOUTS_ENABLED: value }).enabled, false)
  const custom = verificationBonusPayoutConfig({ VERIFICATION_BONUS_MAX_PER_30D_LAMPORTS: '1000000000', VERIFICATION_BONUS_PAYER_RESERVE_LAMPORTS: '0' })
  assert.deepEqual([custom.cap, custom.reserve, custom.error], [1_000_000_000n, 0n, null])
  assert.match(verificationBonusPayoutConfig({ VERIFICATION_BONUS_MAX_PER_30D_LAMPORTS: '5 SOL' }).error, /MAX_PER_30D_LAMPORTS/)
  assert.match(verificationBonusPayoutConfig({ VERIFICATION_BONUS_PAYER_RESERVE_LAMPORTS: '-1' }).error, /PAYER_RESERVE_LAMPORTS/)
})

test('a bonus is eligible when every rule passes, including each inclusive boundary', () => {
  assert.deepEqual(evaluateVerificationBonus(facts()), { complete: true, eligible: true, failures: [] })
  const edge = evaluateVerificationBonus(facts({ verifiedAt: new Date(LAUNCH + 30 * DAY - 1), wallets: { repoPayoutWallet: null },
    repository: { createdAt: iso(LAUNCH - 30 * DAY), stars: 10 } }))
  assert.equal(edge.eligible, true)
  assert.equal(evaluateVerificationBonus(facts({ verifiedAt: new Date(LAUNCH) })).eligible, true)
})

test('each rule failing in turn makes the bonus ineligible with its own reason', () => {
  const cases = [
    ['window', { verifiedAt: new Date(LAUNCH + 30 * DAY) }, /first verified 30\.0 days after launch \(limit 30 days\)/],
    ['window', { verifiedAt: new Date(LAUNCH - 1000) }, /predates/],
    ['self_launch', { wallets: { repoPayoutWallet: 'Launcher' } }, /payout wallet is the launcher wallet/],
    ['self_launch', { wallets: { repoPayoutWallet: 'Maintainer', verifierBoundLauncher: true } }, /bound the launcher wallet/],
    ['self_launch', { wallets: { repoPayoutWallet: null, verifierSignedForLauncher: true } }, /bound the launcher wallet/],
    ['volume', { volume: { other: '999999999', launcher: '9000000000', unattributed: '9000000000' } }, /Only 0\.999999999 SOL .*minimum 1 SOL/],
    ['repo_age', { repository: { createdAt: iso(LAUNCH - 30 * DAY + 1), stars: 500 } }, /created 30\.0 days before launch \(minimum 30 days\)/],
    ['repo_age', { repository: { createdAt: iso(LAUNCH + DAY), stars: 500 } }, /created after the launch/],
    ['stars', { repository: { createdAt: iso(LAUNCH - 365 * DAY), stars: 9 } }, /has 9 stars \(minimum 10\)/],
    ['repository', { repository: { missing: 'GitHub no longer serves this repository publicly (HTTP 404)' } }, /HTTP 404/],
    ['declined', { decision: { kind: 'decline' } }, /^The maintainer declined this market$/],
    ['declined', { decision: { kind: 'opt_out' } }, /opted this repository out/],
  ]
  for (const [rule, change, reason] of cases) {
    const result = evaluateVerificationBonus(facts(change))
    assert.equal(result.complete, true, rule)
    assert.equal(result.eligible, false, rule)
    assert.deepEqual(result.failures.map(failure => failure.rule), [rule])
    assert.match(failureReason(result.failures), reason)
  }
})

test('GitHub is read only when the local rules pass, and every failing rule is reported', () => {
  assert.deepEqual(evaluateVerificationBonus(facts({ repository: undefined })), { complete: false, eligible: false, failures: [] })
  const decided = evaluateVerificationBonus(facts({ repository: undefined, volume: { other: '0' } }))
  assert.deepEqual([decided.complete, decided.eligible, decided.failures.map(f => f.rule)], [true, false, ['volume']])
  const many = evaluateVerificationBonus(facts({ verifiedAt: new Date(LAUNCH + 45 * DAY), wallets: { repoPayoutWallet: 'Launcher' },
    volume: { other: '0' }, repository: { createdAt: iso(LAUNCH), stars: 0 } }))
  assert.deepEqual(many.failures.map(f => f.rule), ['window', 'self_launch', 'volume', 'repo_age', 'stars'])
  assert.equal(failureReason(many.failures).split('; ').length, 5)
  // A maintainer who verified only to decline the market decides the bonus without a GitHub read.
  assert.deepEqual(evaluateVerificationBonus(facts({ repository: undefined, decision: { kind: 'decline' } })).complete, true)
  assert.throws(() => evaluateVerificationBonus(facts({ decision: undefined })), /maintainer decision is required/)
  assert.throws(() => evaluateVerificationBonus(facts({ verifiedAt: 'not a date' })), /timestamp/)
  // Missing facts never pass a rule silently.
  assert.throws(() => evaluateVerificationBonus(facts({ wallets: undefined })), /wallet facts are required/)
  assert.throws(() => evaluateVerificationBonus(facts({ launcherWallet: '' })), /wallet facts are required/)
  assert.throws(() => evaluateVerificationBonus(facts({ volume: {} })), /volume facts are required/)
})

test('the rolling cap counts settled and in-flight payouts and refuses anything above it', () => {
  assert.equal(capAllows({ committed: 0n, amount: 250_000_000n, cap: 5_000_000_000n }), true)
  assert.equal(capAllows({ committed: 4_750_000_000n, amount: 250_000_000n, cap: 5_000_000_000n }), true)
  assert.equal(capAllows({ committed: 4_750_000_001n, amount: 250_000_000n, cap: 5_000_000_000n }), false)
  assert.equal(capAllows({ committed: '0', amount: '1000000', cap: '0' }), false, 'a zero cap pauses payouts')
})

test('the payer keeps its reserve and the revenue held for other uses, counting in-flight payouts as spent', () => {
  const base = { balance: 3_000_000_000n, pending: 0n, amount: 250_000_000n, fee: 17_000n, reserve: 50_000_000n, protectedLamports: 0n }
  assert.equal(payerShortfall(base), 0n)
  assert.equal(payerShortfall({ ...base, protectedLamports: 2_699_983_000n }), 0n, 'exactly enough is enough')
  assert.equal(payerShortfall({ ...base, protectedLamports: 2_699_983_001n }), 1n)
  assert.equal(payerShortfall({ ...base, pending: 250_000_000n, protectedLamports: 2_500_000_000n }), 50_017_000n)
  assert.equal(payerShortfall({ ...base, balance: 0n }), 300_017_000n)
  assert.throws(() => payerShortfall({ ...base, pending: -1n }), /negative/)
})

test('state machine: review decides pending bonuses, only an approved bonus is paid, terminal states stay terminal', () => {
  assert.equal(nextBonusStatus('pending_review', 'approved'), 'approved')
  assert.equal(nextBonusStatus('pending_review', 'rejected'), 'rejected')
  assert.equal(nextBonusStatus('approved', 'rejected'), 'rejected')
  assert.equal(nextBonusStatus('approved', 'paid'), 'paid')
  for (const [from, to] of [['pending_review', 'paid'], ['approved', 'approved'], ['ineligible', 'approved'], ['ineligible', 'paid'],
    ['rejected', 'approved'], ['rejected', 'paid'], ['paid', 'rejected'], ['paid', 'paid'], [undefined, 'approved']]) {
    assert.throws(() => nextBonusStatus(from, to), VerificationBonusError, `${from} -> ${to}`)
  }
  assert.equal(nextPayoutStatus('pending', 'settled'), 'settled')
  assert.equal(nextPayoutStatus('pending', 'aborted'), 'aborted')
  for (const [from, to] of [['settled', 'aborted'], ['settled', 'pending'], ['aborted', 'settled'], ['aborted', 'pending']]) {
    assert.throws(() => nextPayoutStatus(from, to), /cannot move/)
  }
})

test('rejections need a short reason, and every decision binds the amount and wallet the operator saw', () => {
  assert.equal(rejectionReason('  Wash   trading\n by the launcher '), 'Wash trading by the launcher')
  for (const bad of [undefined, null, '', '  x ', 'a'.repeat(301), 42]) assert.throws(() => rejectionReason(bad), /rejection reason/)
  const bonus = { amount: '250000000', launcherWallet: 'Wallet' }
  assert.doesNotThrow(() => requireReviewedTerms(bonus, { amount: '250000000', wallet: 'Wallet' }))
  for (const expected of [{ amount: '250000001', wallet: 'Wallet' }, { amount: '250000000', wallet: 'Other' }, {}, undefined]) {
    assert.throws(() => requireReviewedTerms(bonus, expected), /changed since it was displayed/)
  }
})

test('the public status follows a bonus from offer to receipt, and its deadline is 30 days after activation', () => {
  const row = { amount: '250000000', activatedAt: new Date(LAUNCH) }, now = LAUNCH + DAY
  const base = { amount: '250000000', deadline: '2026-10-31T00:00:00.000Z' }
  assert.equal(verificationBonusView(null), null)
  assert.equal(verificationBonusView({ ...row, amount: null }, now), null)
  assert.deepEqual(verificationBonusView(row, now), { ...base, status: 'offered' })
  assert.deepEqual(verificationBonusView(row, LAUNCH + 30 * DAY), { ...base, status: 'expired' })
  assert.deepEqual(verificationBonusView({ ...row, verified: true }, LAUNCH + 31 * DAY), { ...base, status: 'checking' })
  assert.deepEqual(verificationBonusView({ ...row, status: 'pending_review' }, now), { ...base, status: 'in_review' })
  assert.deepEqual(verificationBonusView({ ...row, status: 'approved' }, now), { ...base, status: 'approved' })
  assert.deepEqual(verificationBonusView({ ...row, status: 'approved', payoutStatus: 'pending', payoutSignature: 'Sig' }, now),
    { ...base, status: 'sending', signature: 'Sig' })
  assert.deepEqual(verificationBonusView({ ...row, status: 'paid', payoutStatus: 'settled', payoutSignature: 'Sig', paidAt: new Date(now) }, now),
    { ...base, status: 'paid', signature: 'Sig', paidAt: iso(now) })
  assert.deepEqual(verificationBonusView({ ...row, status: 'ineligible', reason: 'Too new' }, now), { ...base, status: 'ineligible', reason: 'Too new' })
  assert.deepEqual(verificationBonusView({ ...row, status: 'rejected', reason: 'Wash trading' }, now), { ...base, status: 'rejected' },
    'an operator’s free-text rejection reason is never public')
})

test('launcher copy names the amount and state, links the receipt once sent, and states the rules in one line', () => {
  const base = { amount: '250000000', deadline: '2026-10-31T00:00:00.000Z' }
  assert.deepEqual([verificationBonusCopy({ ...base, status: 'in_review' }).amount, verificationBonusCopy({ ...base, status: 'in_review' }).phrase],
    ['0.25 SOL', 'earned, in review'])
  assert.equal(verificationBonusCopy({ ...base, status: 'approved' }).phrase, 'approved')
  assert.equal(verificationBonusCopy({ ...base, status: 'ineligible', reason: 'The repository has 3 stars (minimum 10)' }).phrase,
    'ineligible: The repository has 3 stars (minimum 10)')
  assert.equal(verificationBonusCopy({ ...base, status: 'paid', signature: 'Sig' }).receipt, 'https://explorer.solana.com/tx/Sig')
  assert.equal(verificationBonusCopy({ ...base, status: 'approved', signature: 'Sig' }).receipt, null)
  assert.match(verificationBonusCopy({ ...base, status: 'offered' }).detail, /before Oct 31, 2026, 00:00 UTC\./)
  assert.match(verificationBonusCopy({ ...base, deadline: '2026-10-29T04:09:38.295Z', status: 'offered' }).detail, /before Oct 29, 2026, 04:09 UTC\./)
  assert.equal(verificationBonusCopy({ ...base, status: 'rejected', reason: 'should not show' }).phrase, 'not approved after review')
  assert.equal(verificationBonusCopy({ ...base, status: 'mystery' }), null)
  assert.equal(verificationBonusCopy(null), null)
  const terms = verificationBonusTerms('250000000')
  assert.match(terms, /0\.25 SOL.*within 30 days of launch.*30\+ days old with 10\+ stars.*trade 1\+ SOL.*self-launches.*reviewed before payout/)
  assert.doesNotMatch(terms, /\n/)
})

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
function storedPayout({ payer, wallet, amount, memo, transfer, extra = [], signers = [payer], price = 200_000 }) {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
      transfer ?? SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wallet, lamports: amount }),
      new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(memo, 'utf8') }), ...extra)
  tx.sign(...signers)
  return Transaction.from(tx.serialize())
}

test('a stored payout must be exactly one payer-to-launcher transfer of the bonus plus its memo, signed by the payer alone', () => {
  const payer = Keypair.generate(), launcher = Keypair.generate(), wallet = launcher.publicKey, amount = 250_000_000n
  const memo = bonusPayoutMemo({ idempotencyKey: payoutIdempotencyKey('7', 1), id: '0f8fad5b-d9cb-469f-a165-70867728950e', amount })
  assert.equal(memo, 'repo.ing verification-bonus:v1:7:1 payout 0f8fad5b-d9cb-469f-a165-70867728950e lamports 250000000')
  const intent = { payer: payer.publicKey.toBase58(), wallet: wallet.toBase58(), amount: amount.toString(), memo }
  assert.deepEqual(checkBonusPayoutShape(storedPayout({ payer, wallet, amount, memo }), intent).amount, amount)
  const stranger = Keypair.generate().publicKey
  const bad = {
    'wrong amount': storedPayout({ payer, wallet, amount: amount - 1n, memo }),
    'wrong recipient': storedPayout({ payer, wallet: stranger, amount, memo }),
    'wrong memo': storedPayout({ payer, wallet, amount, memo: `${memo} ` }),
    'second transfer': storedPayout({ payer, wallet, amount, memo, extra: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger, lamports: 1 })] }),
    'transfer from someone else': storedPayout({ payer, wallet, amount, memo, signers: [payer, launcher],
      transfer: SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: wallet, lamports: amount }) }),
    'launcher co-signs': storedPayout({ payer, wallet, amount, memo, signers: [payer, launcher],
      extra: [new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: wallet, isSigner: true, isWritable: false }], data: Buffer.from('x') })] }),
    'priority fee above the cap': storedPayout({ payer, wallet, amount, memo, price: 2_000_001 }),
    'another program': storedPayout({ payer, wallet, amount, memo, extra: [SystemProgram.createAccount({ fromPubkey: payer.publicKey,
      newAccountPubkey: payer.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId })] }),
  }
  for (const [name, signed] of Object.entries(bad)) assert.throws(() => checkBonusPayoutShape(signed, intent), /settlement review/, name)
})

test('payout requests fail closed before touching the database or chain while payouts are off or misconfigured', async () => {
  const operator = { githubUserId: '285551516', githubLogin: 'operator' }
  const partner = Keypair.generate()
  const pay = env => createVerificationBonusPayouts({ pool: null, connection: null, partner, env }).pay({ repoId: '7', operator, expected: {} })
  await assert.rejects(pay({}), /payouts are off/)
  await assert.rejects(pay({ VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true', VERIFICATION_BONUS_MAX_PER_30D_LAMPORTS: 'lots' }), /MAX_PER_30D_LAMPORTS/)
  await assert.rejects(createVerificationBonusPayouts({ pool: null, connection: null, env: { VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true' } })
    .pay({ repoId: '7', operator }), /signer is not configured/)
  await assert.rejects(createVerificationBonusPayouts({ pool: null, connection: null, partner, env: { VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true' } })
    .pay({ repoId: '07', operator }), /Invalid repository/)
  await assert.rejects(createVerificationBonusPayouts({ pool: null, connection: null, partner, env: { VERIFICATION_BONUS_PAYOUTS_ENABLED: 'true' } })
    .pay({ repoId: '7', operator: {} }), /Operator identity/)
})

test('GitHub facts come from the immutable repository ID; a gone repository is a decision and an outage is retried', async () => {
  const headers = async () => ({})
  const reply = (status, body) => async url => { assert.equal(url, 'https://api.github.com/repositories/7'); return { status, ok: status >= 200 && status < 300, json: async () => body } }
  assert.match((await readRepositoryFacts('7', { fetchImpl: reply(403, { message: 'Repository access blocked' }), headers })).missing, /blocked access/)
  await assert.rejects(readRepositoryFacts('7', { fetchImpl: reply(403, { message: 'API rate limit exceeded' }), headers }), /HTTP 403/)
  const repo = { id: 7, full_name: 'octo/repo', created_at: '2025-01-01T00:00:00Z', stargazers_count: 12, private: false, visibility: 'public' }
  const facts = await readRepositoryFacts('7', { fetchImpl: reply(200, repo), headers })
  assert.deepEqual({ ...facts, checkedAt: undefined }, { createdAt: '2025-01-01T00:00:00.000Z', stars: 12, fullName: 'octo/repo', checkedAt: undefined })
  for (const status of [404, 410, 451]) assert.match((await readRepositoryFacts('7', { fetchImpl: reply(status, {}), headers })).missing, new RegExp(`HTTP ${status}`))
  assert.match((await readRepositoryFacts('7', { fetchImpl: reply(200, { ...repo, private: true }), headers })).missing, /no longer public/)
  await assert.rejects(readRepositoryFacts('7', { fetchImpl: reply(503, {}), headers }), /HTTP 503/)
  await assert.rejects(readRepositoryFacts('7', { fetchImpl: reply(403, {}), headers }), /HTTP 403/)
  await assert.rejects(readRepositoryFacts('7', { fetchImpl: reply(200, { ...repo, id: 8 }), headers }), /identity mismatch/)
  await assert.rejects(readRepositoryFacts('7', { fetchImpl: reply(200, { ...repo, created_at: 'soon' }), headers }), /incomplete/)
  await assert.rejects(readRepositoryFacts('7', { fetchImpl: reply(200, { ...repo, stargazers_count: -1 }), headers }), /incomplete/)
})

test('bonus-stamped markets record the DBC activation point as their launch time, like discovery markets', () => {
  assert.equal(usesActivationClock({ discoveryVersion: 2, verificationBonusLamports: null }), true)
  assert.equal(usesActivationClock({ discoveryVersion: null, verificationBonusLamports: 250_000_000n }), true)
  assert.equal(usesActivationClock({ discoveryVersion: null, verificationBonusLamports: null }), false)
  assert.equal(usesActivationClock({}), false)
})

test('the launch coordinator only accepts a positive bigint bonus stamp', () => {
  const launcher = { creatorWallet: Keypair.generate().publicKey.toBase58() }
  assert.doesNotThrow(() => createLaunchCoordinator({ pool: null, launcher }))
  assert.doesNotThrow(() => createLaunchCoordinator({ pool: null, launcher, verificationBonusLamports: 250_000_000n }))
  for (const bad of [250_000_000, '250000000', 0n, -1n]) {
    assert.throws(() => createLaunchCoordinator({ pool: null, launcher, verificationBonusLamports: bad }), /positive bigint/)
  }
})
