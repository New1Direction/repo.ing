// SERVER-ONLY, isolated default-off wallet identity. No public route, deployment,
// persistent-access setup, wallet call, transaction, signature request or execution.
// Future HTTP wiring must enforce same-origin/CSRF and set Secure HttpOnly SameSite
// cookies. browserBinding comes from a server-issued pre-login cookie, never JSON.
import { createHash, randomBytes } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { verifyWalletSignature } from './github-wallet-links.mjs'
import { HOOK_MAINNET_GENESIS, hookAddress } from './hooklab-execution-contract.mjs'
const sha = value => createHash('sha256').update(value).digest('hex')
const fail = () => Object.assign(new Error('Wallet identity unavailable, expired or changed'), { status: 401 })
const check = value => { if (!value) throw fail() }
const token = value => {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value)
  return value
}
const wallet = value => {
  hookAddress.parse(value); check(PublicKey.isOnCurve(new PublicKey(value).toBuffer())); return value
}
const configSchema = z.object({ enabled: z.boolean().default(false), origin: z.string().refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password } catch { return false }
}), audience: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), genesisHash: z.literal(HOOK_MAINNET_GENESIS) }).strict()
const challengeMessage = row => [
  'repo.ing general launcher wallet identity v1',
  `Origin: ${row.origin}`, `Audience: ${row.audience}`, `Genesis: ${row.genesis_hash}`,
  `Wallet: ${row.wallet}`, `Browser binding SHA256: ${row.browser_binding_sha256}`,
  `Nonce: ${row.nonce}`, `Expires: ${new Date(row.expires_at).toISOString()}`,
  'Sign in to this launcher only. No spending, transaction, creator grant or launch authorization.',
].join('\n')
const noAuthority = { executionAuthorized: false, canSign: false, canSubmit: false, canLaunch: false }

export function walletPrincipalStore(pool, input) {
  const config = Object.freeze(configSchema.parse(input))
  const enabled = () => check(config.enabled === true)
  const scoped = row => row && row.origin === config.origin && row.audience === config.audience && row.genesis_hash === config.genesisHash
  const scope = [config.origin, config.audience, config.genesisHash]
  return Object.freeze({
    async challenge(address, browserBinding) {
      enabled(); wallet(address); const binding = sha(token(browserBinding)), nonce = randomBytes(32).toString('hex')
      const db = await pool.connect()
      try {
        await db.query('begin')
        const { rows: [clock] } = await db.query("select clock_timestamp() + interval '5 minutes' as expires_at")
        const row = { nonce, wallet: address, origin: config.origin, audience: config.audience, genesis_hash: config.genesisHash,
          browser_binding_sha256: binding, expires_at: clock.expires_at }
        const message = challengeMessage(row)
        await db.query(`insert into hook_lab_wallet_challenges
          (nonce,wallet,origin,audience,genesis_hash,browser_binding_sha256,message,expires_at)
          values($1,$2,$3,$4,$5,$6,$7,$8)`, [nonce, address, ...scope, binding, message, row.expires_at])
        await db.query('commit')
        return Object.freeze({ nonce, wallet: address, message, expiresAt: new Date(row.expires_at).toISOString(), ...noAuthority })
      } catch (error) { await db.query('rollback'); throw error } finally { db.release() }
    },
    async verify(input, browserBinding) {
      enabled();
      const { nonce, wallet: address, signature } = z.object({ nonce: z.string(), wallet: hookAddress, signature: z.string().max(88) }).strict().parse(input)
      wallet(address); check(typeof nonce === 'string' && /^[a-f0-9]{64}$/.test(nonce))
      const binding = sha(token(browserBinding))
      check(typeof signature === 'string' && Buffer.from(signature, 'base64').length === 64
        && Buffer.from(signature, 'base64').toString('base64') === signature)
      const db = await pool.connect()
      try {
        await db.query('begin')
        // Serialize before observing the clock: a lock wait cannot extend expiry.
        const { rows: [row] } = await db.query('select * from hook_lab_wallet_challenges where nonce=$1 for update', [nonce])
        const { rows: [clock] } = await db.query('select clock_timestamp() as now')
        check(scoped(row) && row.wallet === address && row.browser_binding_sha256 === binding && !row.consumed_at
          && new Date(row.expires_at) > clock.now && row.message === challengeMessage(row))
        try { verifyWalletSignature(address, row.message, signature) } catch { throw fail() }
        const sessionToken = randomBytes(32).toString('base64url')
        const { rows: [saved] } = await db.query(`insert into hook_lab_wallet_sessions
          (token_sha256,wallet,origin,audience,genesis_hash,expires_at)
          values($1,$2,$3,$4,$5,clock_timestamp()+interval '30 minutes') returning expires_at`, [sha(sessionToken), address, ...scope])
        await db.query('update hook_lab_wallet_challenges set consumed_at=clock_timestamp() where nonce=$1', [nonce])
        await db.query('commit')
        // Return only to the trusted HTTP layer; never log or serialize this token as a public response.
        return Object.freeze({ sessionToken, expiresAt: saved.expires_at.toISOString(), ...noAuthority })
      } catch (error) { await db.query('rollback'); throw error } finally { db.release() }
    },
    async resolve(sessionToken) {
      enabled(); const digest = sha(token(sessionToken))
      const { rows: [row] } = await pool.query(`select wallet,origin,audience,genesis_hash,expires_at from hook_lab_wallet_sessions
        where token_sha256=$1 and origin=$2 and audience=$3 and genesis_hash=$4
          and revoked_at is null and expires_at>clock_timestamp()`, [digest, ...scope])
      check(scoped(row)); wallet(row.wallet)
      return Object.freeze({ kind: 'wallet', wallet: row.wallet, origin: config.origin, audience: config.audience,
        genesisHash: config.genesisHash, expiresAt: row.expires_at.toISOString(), ...noAuthority })
    },
    async revoke(sessionToken) {
      enabled(); await pool.query(`update hook_lab_wallet_sessions set revoked_at=coalesce(revoked_at,clock_timestamp())
        where token_sha256=$1 and origin=$2 and audience=$3 and genesis_hash=$4`, [sha(token(sessionToken)), ...scope])
    },
  })
}
