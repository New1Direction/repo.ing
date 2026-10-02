import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { KNOWN_PROGRAM_ADDRESSES, PASTED_ADDRESS_HOLD_MS, PayoutAddressError, assertConfirmation, checkPayoutAccount,
  parsePayoutAddress, pendingHoldMessage, resolvePayoutRecipient } from '../src/payout-address.mjs'
import { PASTED_ADDRESS_HOLD_HOURS, PAYOUT_ADDRESS_WARNING, bindingLabel, confirmsAddress, formatHoldRemaining, formatUtcDateTime,
  holdRemainingMs, looksLikeSolanaAddress, pendingLabel } from '../src/payout-address-policy.mjs'
import { claimPageStep, builderClaimStep } from '../app/lib/claim-checklist.mjs'
import { isOfficialLaunch, signedPayoutWallet } from '../app/lib/official-launch.mjs'
import { createBuilderReminders, payoutAddressNotice } from '../src/builder-reminders.mjs'

// Address validation, the account check, the hold, recipient resolution and the notice, without PostgreSQL or a validator.
// tests/payout-address-db.test.mjs covers the same rules against real PostgreSQL.
const rejects = (fn, code) => assert.throws(fn, error => error instanceof PayoutAddressError && error.code === code, code)
const wallet = () => Keypair.generate().publicKey.toBase58()

test('a pasted address must be a canonical base58 32-byte on-curve wallet key', () => {
  const address = wallet()
  assert.equal(parsePayoutAddress(address).toBase58(), address)
  assert.equal(parsePayoutAddress(`  ${address}\n`).toBase58(), address, 'surrounding whitespace from a paste is ignored')
  for (const value of [undefined, null, 42, '', '   ']) rejects(() => parsePayoutAddress(value), 'ADDRESS_REQUIRED')
  // Characters outside base58 (0, O, I, l), too short, too long.
  for (const value of [`0${address.slice(1)}`, `O${address.slice(1)}`, `${address.slice(0, -1)}l`, 'abc', address.slice(0, 31), `${address}${address}`]) {
    rejects(() => parsePayoutAddress(value), 'NOT_BASE58')
  }
  // Base58 text of the right length that is not a 32-byte key: 33 bytes, and 24 bytes.
  rejects(() => parsePayoutAddress('z'.repeat(44)), 'WRONG_LENGTH')
  rejects(() => parsePayoutAddress('2'.repeat(32)), 'WRONG_LENGTH')
})

test('the System Program, known programs, sysvars, native mints and the incinerator are refused, though some are on-curve', () => {
  assert.equal(PublicKey.isOnCurve(SystemProgram.programId.toBytes()), true, 'the System Program id passes the curve check alone')
  for (const key of [SystemProgram.programId, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT]) {
    rejects(() => parsePayoutAddress(key.toBase58()), 'PROGRAM_ADDRESS')
  }
  for (const value of ['1nc1nerator11111111111111111111111111111111', 'SysvarRent111111111111111111111111111111111',
    'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG']) rejects(() => parsePayoutAddress(value), 'PROGRAM_ADDRESS')
  for (const value of KNOWN_PROGRAM_ADDRESSES) assert.equal(new PublicKey(value).toBase58(), value, `${value} is a valid key`)
})

test('platform signer addresses and program-derived addresses are refused', () => {
  const platform = wallet()
  rejects(() => parsePayoutAddress(platform, { reserved: [platform, null] }), 'PLATFORM_ADDRESS')
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('payout')], TOKEN_PROGRAM_ID)
  assert.equal(PublicKey.isOnCurve(pda.toBytes()), false)
  rejects(() => parsePayoutAddress(pda.toBase58()), 'OFF_CURVE')
})

test('the last four characters must be retyped exactly', () => {
  const address = '7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs'
  assert.doesNotThrow(() => assertConfirmation(address, 'awMs'))
  assert.doesNotThrow(() => assertConfirmation(address, ' awMs '))
  for (const typed of ['awms', 'AWMS', 'awM', 'wMs', 'xawMs', '', undefined]) rejects(() => assertConfirmation(address, typed), 'CONFIRMATION_MISMATCH')
  assert.equal(confirmsAddress(address, 'awMs'), true)
  assert.equal(confirmsAddress('awMs', 'awMs'), false, 'a four-character "address" confirms nothing')
  assert.equal(looksLikeSolanaAddress(` ${address} `), true)
  assert.equal(looksLikeSolanaAddress('not an address'), false)
})

test('one finalized account read: missing or plain System wallets pass; token accounts, mints, programs and data accounts do not', async () => {
  const key = Keypair.generate().publicKey
  const calls = []
  const connection = info => ({ getAccountInfo: async (...args) => { calls.push(args); return typeof info === 'function' ? info() : info } })
  assert.deepEqual(await checkPayoutAccount(connection(null), key), { exists: false })
  assert.deepEqual(calls[0], [key, 'finalized'])
  assert.deepEqual(await checkPayoutAccount(connection({ owner: SystemProgram.programId, executable: false, data: Buffer.alloc(0), lamports: 5 }), key),
    { exists: true, lamports: 5n })
  for (const info of [
    { owner: TOKEN_PROGRAM_ID, executable: false, data: Buffer.alloc(165), lamports: 2_039_280 },
    { owner: TOKEN_2022_PROGRAM_ID, executable: false, data: Buffer.alloc(82), lamports: 1_461_600 },
    { owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), executable: true, data: Buffer.alloc(36), lamports: 1 },
    { owner: new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'), executable: false, data: Buffer.alloc(400), lamports: 1 },
    { owner: SystemProgram.programId, executable: false, data: Buffer.alloc(80), lamports: 1_447_680 },
  ]) await assert.rejects(checkPayoutAccount(connection(info), key), error => error.code === 'NOT_A_WALLET')
  await assert.rejects(checkPayoutAccount(connection(() => { throw new Error('fetch failed') }), key),
    error => error.code === 'ACCOUNT_UNAVAILABLE' && error.status === 503 && /Nothing was saved/.test(error.message))
  await assert.rejects(checkPayoutAccount(connection(undefined), key), error => error.code === 'ACCOUNT_UNAVAILABLE')
})

test('the hold is 48 hours, matches the database floor, and counts down', () => {
  assert.equal(PASTED_ADDRESS_HOLD_MS, 48 * 60 * 60 * 1000)
  assert.equal(PASTED_ADDRESS_HOLD_HOURS, 48)
  const migration = readFileSync(new URL('../drizzle/0048_pasted_payout_address.sql', import.meta.url), 'utf8')
  assert.match(migration, /"active_at" >= "requested_at" \+ interval '48 hours'/)
  const now = Date.parse('2026-10-02T12:00:00Z'), activeAt = new Date(now + PASTED_ADDRESS_HOLD_MS).toISOString()
  assert.equal(holdRemainingMs(activeAt, now), PASTED_ADDRESS_HOLD_MS)
  assert.equal(holdRemainingMs(activeAt, now + PASTED_ADDRESS_HOLD_MS + 1), 0)
  assert.equal(holdRemainingMs('not a date', now), 0)
  assert.equal(formatHoldRemaining(PASTED_ADDRESS_HOLD_MS), '48 h')
  assert.equal(formatHoldRemaining(47 * 3_600_000 + 5 * 60_000), '47 h 5 min')
  assert.equal(formatHoldRemaining(12 * 60_000), '12 min')
  assert.equal(formatHoldRemaining(30_000), 'under a minute')
  assert.equal(formatHoldRemaining(0), 'now')
  assert.equal(formatUtcDateTime(activeAt), 'Oct 4, 12:00 UTC')
  assert.equal(pendingHoldMessage(activeAt), `This repository's pasted payout address is in its 48-hour hold until ${activeAt}. Claims open then.`)
  assert.equal(PAYOUT_ADDRESS_WARNING, 'Use a Solana wallet you control. Exchange deposit addresses may not credit program payouts.')
})

test('destination labels say how the active address was set and when a pasted one activates', () => {
  assert.equal(bindingLabel({ wallet: 'W', method: 'signature', boundAt: '2026-10-01T09:30:00Z' }), 'Verified by wallet signature')
  assert.equal(bindingLabel({ wallet: 'W', method: 'pasted', boundAt: '2026-10-01T09:30:00Z' }), 'Pasted address, active since Oct 1, 09:30 UTC')
  assert.equal(bindingLabel(null), '')
  assert.equal(pendingLabel({ activeAt: '2026-10-04T12:00:00Z' }), 'Pasted address, active from Oct 4, 12:00 UTC')
})

// A scripted stand-in for the claim's locked PostgreSQL client: it records every statement and answers the few the
// recipient resolution runs. due: the pending request's hold has passed (the SQL filter active_at <= now()).
function fakeClient({ binding = null, pending = null, due = false }) {
  const state = { binding, pending, statements: [] }
  return { state, async query(text, params = []) {
    const sql = text.replace(/\s+/g, ' ').trim()
    state.statements.push(sql)
    if (/^(begin|commit|rollback)$/.test(sql) || sql.startsWith('select pg_advisory_xact_lock')) return { rows: [] }
    if (sql.includes('from payout_address_requests r left join repo_beneficiaries b')) {
      return { rows: state.pending && due ? [{ id: '1', wallet: state.pending.wallet, requestedBy: '7', currentWallet: state.binding?.wallet ?? null,
        currentUser: state.binding ? '7' : null, newerBinding: false }] : [] }
    }
    if (sql.startsWith("update payout_address_requests set status = 'activated'")) return { rows: [] }
    if (sql.startsWith('insert into repo_beneficiaries')) {
      state.binding = { wallet: params[2], boundAt: new Date(), method: 'pasted', githubUserId: params[1] }
      state.pending = null
      return { rows: [] }
    }
    if (sql.startsWith('insert into payout_address_events')) return { rows: [] }
    if (sql.includes('from repo_beneficiaries where github_repo_id = $1')) return { rows: state.binding ? [state.binding] : [] }
    if (sql.includes("from payout_address_requests where github_repo_id = $1 and status = 'pending'")) {
      return { rows: state.pending ? [{ id: '1', wallet: state.pending.wallet, activeAt: state.pending.activeAt }] : [] }
    }
    throw new Error(`unexpected statement: ${sql}`)
  } }
}

test('the claim recipient is only ever the active binding; a pasted address in its hold is never returned', async () => {
  const active = { wallet: wallet(), boundAt: new Date('2026-09-01T00:00:00Z'), method: 'signature', githubUserId: '7' }
  const waiting = { wallet: wallet(), activeAt: new Date(Date.now() + PASTED_ADDRESS_HOLD_MS) }

  let client = fakeClient({ pending: waiting })
  await assert.rejects(resolvePayoutRecipient(client, '42'), new RegExp(`48-hour hold until ${waiting.activeAt.toISOString()}`))
  assert.equal(client.state.binding, null, 'nothing was bound')

  client = fakeClient({ binding: active, pending: waiting })
  assert.equal((await resolvePayoutRecipient(client, '42')).wallet, active.wallet, 'the previous binding keeps receiving claims')
  const lock = client.state.statements.indexOf('select pg_advisory_xact_lock($1::bigint)')
  assert.ok(lock > 0 && client.state.statements.findIndex(s => s.includes('from repo_beneficiaries where')) > lock, 'activation is checked under the lock first')

  client = fakeClient({ binding: active, pending: waiting, due: true })
  const recipient = await resolvePayoutRecipient(client, '42')
  assert.deepEqual([recipient.wallet, recipient.method], [waiting.wallet, 'pasted'], 'once due, the pasted address is the binding')
  assert.ok(recipient.boundAt > active.boundAt, 'with a new binding time, which invalidates reviews of the previous recipient')

  await assert.rejects(resolvePayoutRecipient(fakeClient({}), '42'), /no bound beneficiary/)
  await assert.rejects(resolvePayoutRecipient(fakeClient({}), 'x'), error => error.code === 'INVALID_REPOSITORY')
})

test('claim steps: a pasted active address completes the payout step without a wallet; a waiting one never does', () => {
  assert.equal(claimPageStep({ githubReady: true, appReady: true, walletMatches: false, pastedActive: true }), 3)
  assert.equal(claimPageStep({ githubReady: true, appReady: true, walletMatches: false, pastedActive: false }), 2)
  assert.equal(claimPageStep({ githubReady: false, appReady: true, walletMatches: false, pastedActive: true }), 1)
  const waiting = { wallet: null, pending: { activeAt: '2026-10-04T12:00:00Z' }, available: '5' }
  assert.equal(builderClaimStep({ needsLogin: false, repositories: [waiting] }), 3, 'a waiting address is set; it only has to wait')
  assert.equal(builderClaimStep({ needsLogin: false, repositories: [{ wallet: null, pending: null, available: '5' }] }), 2)
})

test('identity marks need a wallet-signature binding: a pasted address proves no control of the wallet', () => {
  const market = { wasVerified: true, beneficiaryWallet: 'L', launcherWallet: 'L' }
  assert.equal(isOfficialLaunch({ ...market, beneficiaryMethod: 'signature' }), true)
  assert.equal(isOfficialLaunch(market), true, 'rows without the column keep their meaning')
  assert.equal(isOfficialLaunch({ ...market, beneficiaryMethod: 'pasted' }), false)
  // The ✓ maintainer X handle, the launcher's "Maintainer's payout wallet" and the backers' Builder label all read this.
  assert.equal(signedPayoutWallet({ beneficiaryWallet: 'W', beneficiaryMethod: 'signature' }), 'W')
  assert.equal(signedPayoutWallet({ beneficiaryWallet: 'W' }), 'W')
  assert.equal(signedPayoutWallet({ beneficiaryWallet: 'W', beneficiaryMethod: 'pasted' }), null)
  assert.equal(signedPayoutWallet({ beneficiaryWallet: null, beneficiaryMethod: null }), null)
  assert.equal(signedPayoutWallet(null), null)
})

test('the change notice names the address, the activation time, the current recipient and where to cancel', () => {
  const notice = payoutAddressNotice({ origin: 'https://repo.ing', repos: [{ repoId: '42', fullName: 'octo/widget' }], wallet: 'NewAddress',
    activeAt: '2026-10-04T12:00:00.000Z', requestedByLogin: 'octocat', previousWallet: 'OldAddress', unsubscribe: 'https://repo.ing/builders/reminders#unsubscribe=t' })
  assert.equal(notice.subject, 'Payout address change requested for octo/widget')
  for (const part of ['GitHub user octocat', 'NewAddress', '2026-10-04T12:00:00.000Z', 'OldAddress', 'https://repo.ing/claim/42', 'never authorizes a payout', '#unsubscribe=t']) {
    assert.ok(notice.text.includes(part), part)
  }
  const batch = payoutAddressNotice({ origin: 'https://repo.ing', repos: [{ repoId: '1', fullName: 'a/one' }, { repoId: '2', fullName: 'a/two' }],
    wallet: 'W', activeAt: '2026-10-04T12:00:00.000Z', requestedByLogin: 'octocat', previousWallet: null, unsubscribe: 'u' })
  assert.equal(batch.subject, 'Payout address change requested for 2 repositories')
  assert.ok(batch.text.includes('Until then, claims stay closed.') && batch.text.includes('- a/two') && batch.text.includes('/claim/2'))
})

test('only confirmed reminder subscribers among the affected builders are emailed, once per request and recipient', async () => {
  const sent = [], queries = []
  const pool = { query: async (text, params) => {
    queries.push(text)
    if (text.includes('from builder_reminders')) {
      assert.match(text, /verified_at is not null/)
      assert.deepEqual(params[0], ['7', '8'])
      return { rows: [{ github_user_id: '7', email: 'owner@example.com', revision: 'a'.repeat(32) }, { github_user_id: '8', email: 'co@example.com', revision: 'b'.repeat(32) }] }
    }
    return { rows: [{ repoId: '42', fullName: 'octo/widget' }] }
  } }
  let fail = false
  const service = createBuilderReminders({ pool, secret: 's'.repeat(32), origin: 'https://repo.ing',
    send: async message => { sent.push(message); if (fail) throw Error('timeout'); return 'id' } })
  const notice = { githubUserIds: ['7', '8', '7', 'bad'], key: '99', repoIds: ['42'], wallet: 'NewAddress', activeAt: '2026-10-04T12:00:00.000Z', requestedByLogin: 'octocat' }
  assert.deepEqual(await service.notifyPayoutAddressChange(notice), { status: 'CHECKED', accepted: 2, failed: 0 })
  assert.deepEqual(sent.map(m => [m.to, m.key]), [['owner@example.com', 'payout-address-99-7'], ['co@example.com', 'payout-address-99-8']])
  assert.ok(sent.every(m => m.text.includes('/builders/reminders#unsubscribe=')))
  fail = true
  assert.deepEqual(await service.notifyPayoutAddressChange(notice), { status: 'CHECKED', accepted: 0, failed: 2 })
  const disabled = createBuilderReminders({ pool, secret: 's'.repeat(32), origin: 'https://repo.ing', send: null })
  queries.length = 0
  assert.deepEqual(await disabled.notifyPayoutAddressChange(notice), { status: 'DISABLED', accepted: 0, failed: 0 })
  assert.equal(queries.length, 0, 'no lookup at all while email is not configured')
})
