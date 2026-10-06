import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { EARLY_ACCESS_LAUNCHES_READY, EARLY_ACCESS_MAX_SECONDS, EARLY_ACCESS_MIN_SECONDS, EARLY_ACCESS_WINDOWS, EarlyAccessError, earlyAccessDbcConfig,
  earlyAccessEnabled, earlyAccessLaunchable, earlyAccessLookupTable, earlyAccessOracle, earlyAccessWindow } from '../src/early-access.mjs'
import { MAX_EARLY_ACCESS_SECONDS } from '../src/early-access-hook.mjs'
import { GithubWalletLinkError, LINK_ERRORS, assertLinkable, canonicalWallet, contributorIdentity, contributorWalletMessage, githubUserIdOf,
  verifyWalletSignature } from '../src/github-wallet-links.mjs'
import { batchBindingMessage, modelBindingMessage } from '../src/wallet-binding.mjs'
import { linkMessage } from '../src/x-links.mjs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

// Contributor early access, step 3 (docs/EARLY_ACCESS.md): the switches, the window rules, the settings, and the contributor
// wallet link's message, signature and refusals. No database: the link flow on PostgreSQL is tests/early-access-links-db.test.mjs.

const signer = () => {
  const pair = generateKeyPairSync('ed25519')
  const address = new PublicKey(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toBase58()
  return { address, sign: message => sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('base64') }
}
const refusal = (key, status) => error => error instanceof GithubWalletLinkError && error.message === LINK_ERRORS[key] && (status === undefined || error.status === status)

test('EARLY_ACCESS_ENABLED is on only when exactly "true"; launches also need the code gate, which is closed', () => {
  for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) assert.equal(earlyAccessEnabled({ EARLY_ACCESS_ENABLED: value }), false, String(value))
  assert.equal(earlyAccessEnabled({ EARLY_ACCESS_ENABLED: 'true' }), true)
  assert.equal(EARLY_ACCESS_LAUNCHES_READY, false)
  assert.equal(earlyAccessLaunchable({ EARLY_ACCESS_ENABLED: 'true' }), false)
  assert.equal(earlyAccessLaunchable({}), false)
})

test('the window is a whole number of seconds from 15 minutes to the hook program\'s 24 hours', () => {
  assert.equal(EARLY_ACCESS_MIN_SECONDS, 900)
  assert.equal(EARLY_ACCESS_MAX_SECONDS, MAX_EARLY_ACCESS_SECONDS)
  assert.equal(EARLY_ACCESS_MAX_SECONDS, 86_400)
  for (const value of [900, 901, 3600, 86_400, '900', '86400']) assert.equal(earlyAccessWindow(value), Number(value))
  for (const value of [899, 86_401, 0, -900, 1800.5, '1800.5', ' 900', '9e2', '0x384', NaN, Infinity, null, undefined, true, [900], { seconds: 900 }, 900n]) {
    assert.throws(() => earlyAccessWindow(value), error => error instanceof EarlyAccessError && error.status === 400 &&
      error.message === 'Choose an early access window from 15 minutes to 24 hours.', String(value))
  }
})

test('the form offers 15 minutes, 1 hour, 6 hours and 24 hours, each a valid window', () => {
  assert.deepEqual(EARLY_ACCESS_WINDOWS.map(choice => [choice.seconds, choice.label]), [[900, '15 minutes'], [3600, '1 hour'], [21_600, '6 hours'], [86_400, '24 hours']])
  for (const choice of EARLY_ACCESS_WINDOWS) assert.equal(earlyAccessWindow(choice.seconds), choice.seconds)
  assert.ok(Object.isFrozen(EARLY_ACCESS_WINDOWS) && EARLY_ACCESS_WINDOWS.every(Object.isFrozen))
})

test('settings: unset is null, a valid key parses, a malformed one throws naming the variable and never its value', () => {
  const config = Keypair.generate().publicKey.toBase58(), table = Keypair.generate().publicKey.toBase58()
  assert.equal(earlyAccessDbcConfig({}), null)
  assert.equal(earlyAccessLookupTable({ EARLY_ACCESS_LOOKUP_TABLE: '  ' }), null)
  assert.equal(earlyAccessDbcConfig({ EARLY_ACCESS_DBC_CONFIG: config }).toBase58(), config)
  assert.equal(earlyAccessLookupTable({ EARLY_ACCESS_LOOKUP_TABLE: ` ${table}\n` }).toBase58(), table)
  assert.throws(() => earlyAccessDbcConfig({ EARLY_ACCESS_DBC_CONFIG: 'not-a-key' }), /^Error: EARLY_ACCESS_DBC_CONFIG must be a base58 public key$/)
  assert.throws(() => earlyAccessLookupTable({ EARLY_ACCESS_LOOKUP_TABLE: `${table}x` }), /EARLY_ACCESS_LOOKUP_TABLE/)

  const oracle = Keypair.generate()
  assert.equal(earlyAccessOracle({}), null)
  assert.equal(earlyAccessOracle({ EARLY_ACCESS_ORACLE_SECRET_KEY: bs58.encode(oracle.secretKey) }).publicKey.toBase58(), oracle.publicKey.toBase58())
  assert.equal(earlyAccessOracle({ EARLY_ACCESS_ORACLE_SECRET_KEY: JSON.stringify([...oracle.secretKey]) }).publicKey.toBase58(), oracle.publicKey.toBase58())
  const mismatched = Uint8Array.from([...oracle.secretKey.subarray(0, 32), ...Keypair.generate().publicKey.toBytes()])
  for (const secret of [bs58.encode(oracle.secretKey.subarray(0, 32)), bs58.encode(mismatched), JSON.stringify([...oracle.secretKey].map(byte => byte + 256)),
    `${JSON.stringify([...oracle.secretKey])}]`, 'secret-value-123']) {
    assert.throws(() => earlyAccessOracle({ EARLY_ACCESS_ORACLE_SECRET_KEY: secret }), error => {
      assert.equal(error.message, 'EARLY_ACCESS_ORACLE_SECRET_KEY must be a 64-byte secret key (base58 or a JSON byte array)')
      assert.ok(!String(error.stack).includes(secret.slice(0, 12)), 'the error never carries the value')
      return true
    })
  }
})

test('.env.example names every setting with no value', () => {
  const example = readFileSync('.env.example', 'utf8')
  assert.match(example, /^EARLY_ACCESS_ENABLED=false$/m)
  for (const name of ['EARLY_ACCESS_DBC_CONFIG', 'EARLY_ACCESS_LOOKUP_TABLE', 'EARLY_ACCESS_ORACLE_SECRET_KEY']) assert.match(example, new RegExp(`^${name}=$`, 'm'))
})

const CHALLENGE = { githubLogin: 'octocat', githubUserId: '583231', wallet: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2',
  nonce: '0123456789abcdef0123456789abcdef0123456789abcdef', expiresAt: new Date('2026-10-05T12:05:00.000Z') }

test('the contributor wallet message is exactly five lines, in its own domain', () => {
  assert.equal(contributorWalletMessage(CHALLENGE), [
    'repo.ing contributor wallet v1',
    'GitHub user: octocat (583231)',
    'Wallet: 7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2',
    'Nonce: 0123456789abcdef0123456789abcdef0123456789abcdef',
    'Expires: 2026-10-05T12:05:00.000Z',
  ].join('\n'))
  // No other message a repo.ing wallet signs starts the same way.
  const first = message => message.split('\n')[0]
  const others = [modelBindingMessage({ githubRepoId: 1, hfId: 'a'.repeat(24), authoritySubject: 'b'.repeat(24), wallet: CHALLENGE.wallet, nonce: CHALLENGE.nonce, expiresAt: CHALLENGE.expiresAt }),
    batchBindingMessage([{ wallet: CHALLENGE.wallet, githubUserId: 1, githubRepoId: 1, nonce: CHALLENGE.nonce, expiresAt: CHALLENGE.expiresAt }]),
    linkMessage({ username: 'octocat', wallet: CHALLENGE.wallet, xUserId: '1', nonce: 'n', expiresAt: 0 })]
  for (const other of others) assert.notEqual(first(other), first(contributorWalletMessage(CHALLENGE)))
  assert.ok(others.every(other => !other.includes('contributor wallet')))
})

test('a wallet signature verifies only for that wallet and that exact message', () => {
  const wallet = signer(), other = signer()
  const message = contributorWalletMessage({ ...CHALLENGE, wallet: wallet.address })
  verifyWalletSignature(wallet.address, message, wallet.sign(message))
  assert.throws(() => verifyWalletSignature(other.address, message, wallet.sign(message)), refusal('signature'))
  assert.throws(() => verifyWalletSignature(wallet.address, `${message} `, wallet.sign(message)), refusal('signature'))
  assert.throws(() => verifyWalletSignature(wallet.address, message, other.sign(message)), refusal('signature'))
  const good = wallet.sign(message)
  for (const bad of [undefined, '', good.slice(0, -2), `${good}A`, Buffer.from(good, 'base64').toString('hex'), bs58.encode(Buffer.from(good, 'base64')), ` ${good}`]) {
    assert.throws(() => verifyWalletSignature(wallet.address, message, bad), refusal('signature'), String(bad))
  }
})

test('a signed link is refused when its challenge is missing, another account\'s or wallet\'s, used, expired or badly signed', () => {
  const wallet = signer(), other = signer()
  const row = { ...CHALLENGE, wallet: wallet.address, consumedAt: null }
  const signature = wallet.sign(contributorWalletMessage(row))
  const request = { githubUserId: '583231', wallet: wallet.address, signature }
  const before = new Date('2026-10-05T12:04:59.999Z')
  assertLinkable(row, request, before)
  assert.throws(() => assertLinkable(undefined, request, before), refusal('expired', 410))
  assert.throws(() => assertLinkable(row, { ...request, githubUserId: '583232' }, before), refusal('mismatch', 403))
  assert.throws(() => assertLinkable(row, { ...request, wallet: other.address, signature: other.sign(contributorWalletMessage(row)) }, before), refusal('mismatch', 403))
  assert.throws(() => assertLinkable({ ...row, consumedAt: new Date('2026-10-05T12:01:00Z') }, request, before), refusal('used', 409))
  assert.throws(() => assertLinkable(row, request, new Date('2026-10-05T12:05:00.000Z')), refusal('expired', 410))
  // A signature over another login, nonce or expiry than the stored challenge's does not verify.
  for (const changed of [{ githubLogin: 'octocat2' }, { nonce: 'f'.repeat(48) }, { expiresAt: new Date('2026-10-05T12:06:00Z') }]) {
    assert.throws(() => assertLinkable(row, { ...request, signature: wallet.sign(contributorWalletMessage({ ...row, ...changed })) }, before), refusal('signature', 400))
  }
})

test('only a personal GitHub account links: bots and organizations are refused, and the login is checked', () => {
  assert.deepEqual(contributorIdentity({ githubUserId: 583231n, githubLogin: 'octocat', type: 'User' }), { githubUserId: '583231', githubLogin: 'octocat' })
  assert.deepEqual(contributorIdentity({ githubUserId: 9, githubLogin: 'jane_corp', type: 'User' }), { githubUserId: '9', githubLogin: 'jane_corp' })
  assert.throws(() => contributorIdentity({ githubUserId: 49699333n, githubLogin: 'dependabot[bot]', type: 'Bot' }), refusal('bot', 403))
  assert.throws(() => contributorIdentity({ githubUserId: 1, githubLogin: 'renovate[bot]', type: 'User' }), refusal('bot', 403))
  assert.throws(() => contributorIdentity({ githubUserId: 1, githubLogin: 'some-app', type: 'Bot' }), refusal('bot', 403))
  assert.throws(() => contributorIdentity({ githubUserId: 1, githubLogin: 'github', type: 'Organization' }), refusal('personal', 403))
  assert.throws(() => contributorIdentity({ githubUserId: 1, githubLogin: 'octocat' }), refusal('personal', 403))
  for (const githubLogin of ['', 'octo cat', 'octo\ncat', '-octocat', 'a'.repeat(101), 'octo(cat)']) {
    assert.throws(() => contributorIdentity({ githubUserId: 1, githubLogin, type: 'User' }), refusal('account'), githubLogin)
  }
  for (const githubUserId of [0, -1, '01', '1.5', 'abc', 9007199254740992n, undefined, null]) assert.throws(() => githubUserIdOf(githubUserId), refusal('account'), String(githubUserId))
})

test('wallets must be canonical base58 public keys', () => {
  const { address } = signer()
  assert.equal(canonicalWallet(address), address)
  // Wrong case: a fixed key whose lower-case form is not a key (a random key's lower-case form is a valid other key about a
  // quarter of the time, which made this check flaky).
  const wrongCase = 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3'.toLowerCase()
  for (const value of [undefined, '', ` ${address}`, `${address}1`, 'not a wallet', wrongCase]) assert.throws(() => canonicalWallet(value), refusal('wallet'), String(value))
})

test('migration 0059 is journaled last, re-appliable, and its constraint names match the schema', () => {
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  assert.deepEqual(entries.at(-1), { idx: 59, version: '7', when: 1790910019000, tag: '0059_early_access', breakpoints: true })
  const sql = readFileSync('drizzle/0059_early_access.sql', 'utf8')
  for (const statement of sql.split('--> statement-breakpoint').map(part => part.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
    assert.match(statement, /^(SET LOCAL|ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS|DO \$\$ BEGIN\s+IF NOT EXISTS|CREATE OR REPLACE FUNCTION|CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS)/, statement.slice(0, 80))
  }
  const schema = readFileSync('src/db/schema.mjs', 'utf8')
  const names = [...sql.matchAll(/CONSTRAINT "(\w+)"|conname = '(\w+)'|INDEX IF NOT EXISTS "(\w+)"/g)].map(match => match[1] ?? match[2] ?? match[3])
  assert.ok(names.length >= 15)
  for (const name of names) {
    const declared = schema.includes(`'${name}'`) || (name.endsWith('_github_only') && schema.includes(`githubOnly('${name.replace(/_github_only$/, '')}'`))
    assert.ok(declared, `${name} is declared in src/db/schema.mjs`)
  }
})

test('dark: the page, its API and the contributor sign-in do not exist while EARLY_ACCESS_ENABLED is off', async () => {
  const saved = { flag: process.env.EARLY_ACCESS_ENABLED, origin: process.env.APP_ORIGIN }
  process.env.EARLY_ACCESS_ENABLED = 'false'
  process.env.APP_ORIGIN = 'https://repo.ing'
  try {
    const page = await appModule('app/(site)/contributors/link/page.jsx')
    await assert.rejects(page.default({ searchParams: Promise.resolve({}) }), error => String(error.digest).startsWith('NEXT_HTTP_ERROR_FALLBACK;404'))
    const request = (path, method = 'GET') => Object.assign(new Request(`https://repo.ing${path}`, { method, headers: { origin: 'https://repo.ing' } }),
      { cookies: { get: () => undefined }, nextUrl: new URL(`https://repo.ing${path}`) })
    const account = await import('../app/api/contributor-wallet/route.js')
    const { POST: challenge } = await import('../app/api/contributor-wallet/challenge/route.js')
    const { POST: link } = await import('../app/api/contributor-wallet/link/route.js')
    for (const response of [await account.GET(request('/api/contributor-wallet')), await account.DELETE(request('/api/contributor-wallet', 'DELETE')),
      await challenge(request('/api/contributor-wallet/challenge', 'POST')), await link(request('/api/contributor-wallet/link', 'POST'))]) {
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { error: 'Not found' })
    }
    const { GET: start } = await import('../app/api/github/start/route.js')
    const response = await start(request('/api/github/start?mode=contributor'))
    assert.equal(response.status, 307)
    assert.equal(new URL(response.headers.get('location')).pathname, '/explore')
    assert.equal(response.headers.get('set-cookie'), null, 'no sign-in starts')
  } finally {
    for (const [key, value] of [['EARLY_ACCESS_ENABLED', saved.flag], ['APP_ORIGIN', saved.origin]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('the link panel: signed out, it offers the identity-only contributor sign-in', async () => {
  const { ContributorWallet } = await appModule('app/components/contributor-wallet.jsx')
  const markup = html(h(ContributorWallet, { signedIn: false, githubLogin: null, errorCode: null }), { wallet: true })
  assert.match(markup, /href="\/api\/github\/start\?mode=contributor"/)
  assert.match(markup, /Sign in with GitHub/)
  assert.doesNotMatch(markup, /paste|address field/i)
  assert.match(html(h(ContributorWallet, { signedIn: false, githubLogin: null, errorCode: 'verification-failed' }), { wallet: true }), /GitHub sign-in could not finish/)
})
