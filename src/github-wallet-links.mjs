import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { takeQuota } from './request-quota.mjs'

// Contributor wallet links (docs/EARLY_ACCESS.md, step 3): a GitHub account names the one wallet that may buy during a
// repository's early access window, if the account is one of the repository's contributors. GitHub sign-in (identity only,
// no repository authority) proves the account; an Ed25519 signature of a single-use challenge proves the wallet. There is no
// paste-an-address path: a link never moves money, but it decides who may buy, so the wallet must sign.
// Table rules (drizzle/0059_early_access.sql): one wallet per GitHub user id; re-linking replaces it; a wallet linked to
// another account is refused, never moved.

export const LINK_CHALLENGE_SECONDS = 5 * 60
// Per-address quotas (agent_request_limits, src/request-quota.mjs): [limit, window seconds]. A challenge also reads GitHub
// with the user's token, so the account has its own, tighter quota as well.
export const LINK_LIMITS = Object.freeze({ challenge: [20, 600], challengeAccount: [10, 600], link: [30, 600], unlink: [10, 600] })

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const NONCE = /^[0-9a-f]{48}$/
const USER_ID = /^[1-9]\d{0,15}$/
const MAX_USER_ID = 9007199254740991n
// GitHub logins: letters, digits and hyphens (managed users add "_shortcode"). The message format relies on it: no spaces,
// brackets or line breaks.
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const BOT_LOGIN = /\[bot\]$/i
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/

export class GithubWalletLinkError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'GithubWalletLinkError'; this.status = status }
}

export const LINK_ERRORS = Object.freeze({
  signIn: 'Sign in with GitHub first.',
  account: 'GitHub did not confirm this account. Sign in again.',
  bot: 'Bot accounts cannot link a wallet.',
  personal: 'Only personal GitHub accounts can link a wallet.',
  wallet: 'Invalid wallet address.',
  taken: 'This wallet is linked to another GitHub account.',
  expired: 'This signature request expired. Try again.',
  used: 'This signature request was already used. Try again.',
  mismatch: 'This signature request is for another account or wallet. Try again.',
  signature: 'The wallet signature does not match. Try again.',
  limited: 'Too many requests. Try again later.',
})
const fail = (key, status) => new GithubWalletLinkError(LINK_ERRORS[key], status)

// A GitHub user id as its decimal string (ids are below 2^53).
export function githubUserIdOf(value) {
  const text = typeof value === 'bigint' ? value.toString() : typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !USER_ID.test(text) || BigInt(text) > MAX_USER_ID) throw fail('account')
  return text
}

// The signed-in account, as GitHub reported it just now ({ githubUserId, githubLogin, type }). Bots are refused: by GitHub's
// account type, and by the "[bot]" login suffix GitHub gives app accounts.
export function contributorIdentity(identity) {
  const githubUserId = githubUserIdOf(identity?.githubUserId), login = identity?.githubLogin
  if ((typeof login === 'string' && BOT_LOGIN.test(login)) || identity?.type === 'Bot') throw fail('bot', 403)
  if (identity?.type !== 'User') throw fail('personal', 403)
  if (typeof login !== 'string' || !GITHUB_LOGIN.test(login)) throw fail('account')
  return { githubUserId, githubLogin: login }
}

// The canonical base58 form only.
export function canonicalWallet(value) {
  try {
    const key = new PublicKey(String(value ?? '')).toBase58()
    if (key !== value) throw Error()
    return key
  } catch { throw fail('wallet') }
}

// What the wallet signs. Its first line is its own domain: it can never be read as a payout binding, a model binding or an
// X link message (src/wallet-binding.mjs, src/x-links.mjs).
export const contributorWalletMessage = ({ githubLogin, githubUserId, wallet, nonce, expiresAt }) => [
  'repo.ing contributor wallet v1',
  `GitHub user: ${githubLogin} (${githubUserId})`,
  `Wallet: ${wallet}`,
  `Nonce: ${nonce}`,
  `Expires: ${new Date(expiresAt).toISOString()}`,
].join('\n')

// signature: the 64-byte Ed25519 signature, base64 (what the page sends).
export function verifyWalletSignature(wallet, message, signature) {
  if (typeof signature !== 'string' || !SIGNATURE_BASE64.test(signature)) throw fail('signature')
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(wallet).toBuffer()]), format: 'der', type: 'spki' })
  if (!verifySignature(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(signature, 'base64'))) throw fail('signature')
}

// Every check a signed link must pass against its challenge row (or undefined), in order. now: the database's clock.
export function assertLinkable(challenge, { githubUserId, wallet, signature }, now) {
  if (!challenge) throw fail('expired', 410)
  if (challenge.githubUserId !== githubUserId || challenge.wallet !== wallet) throw fail('mismatch', 403)
  if (challenge.consumedAt) throw fail('used', 409)
  if (new Date(challenge.expiresAt).getTime() <= new Date(now).getTime()) throw fail('expired', 410)
  verifyWalletSignature(wallet, contributorWalletMessage(challenge), signature)
}

// ---------- PostgreSQL ----------
const LINK_COLUMNS = `github_user_id::text as "githubUserId", github_login as "githubLogin", wallet, linked_at as "linkedAt", updated_at as "updatedAt"`
const CHALLENGE_COLUMNS = `nonce, github_user_id::text as "githubUserId", github_login as "githubLogin", wallet, expires_at as "expiresAt",
  consumed_at as "consumedAt"`
const iso = value => new Date(value).toISOString()
const publicLink = row => row ? { githubUserId: row.githubUserId, githubLogin: row.githubLogin, wallet: row.wallet,
  linkedAt: iso(row.linkedAt), updatedAt: iso(row.updatedAt) } : null

// Read helpers; executor: a pg Pool or client.
export async function linkForGithubUser(executor, githubUserId) {
  const { rows } = await executor.query(`select ${LINK_COLUMNS} from github_wallet_links where github_user_id = $1`, [githubUserIdOf(githubUserId)])
  return publicLink(rows[0])
}

// The links of the accounts that have one, by user id (step 4: a repository's contributor snapshot to allow-list wallets).
export async function linksForGithubUsers(executor, githubUserIds) {
  const ids = [...new Set([...githubUserIds].map(githubUserIdOf))]
  if (!ids.length) return []
  const { rows } = await executor.query(`select ${LINK_COLUMNS} from github_wallet_links where github_user_id = any($1::bigint[])
    order by github_user_id`, [ids])
  return rows.map(publicLink)
}

export async function githubUserForWallet(executor, wallet) {
  const { rows } = await executor.query(`select ${LINK_COLUMNS} from github_wallet_links where wallet = $1`, [canonicalWallet(wallet)])
  return publicLink(rows[0])
}

export function createGithubWalletLinks({ pool }) {
  return {
    async quota(scopes) { if (!await takeQuota(pool, scopes)) throw fail('limited', 429) },
    linkFor: githubUserId => linkForGithubUser(pool, githubUserId),

    // identity: contributorIdentity's input, read from GitHub just now. Refused early (and again when linking) when the
    // wallet is another account's.
    async challenge({ identity, wallet }) {
      const who = contributorIdentity(identity), address = canonicalWallet(wallet)
      const owner = await githubUserForWallet(pool, address)
      if (owner && owner.githubUserId !== who.githubUserId) throw fail('taken', 409)
      await pool.query(`delete from github_wallet_link_challenges where expires_at < now() - interval '1 day'`)
      const nonce = randomBytes(24).toString('hex')
      // Both times from the database's clock, so the five minutes hold whatever this server's clock says.
      const { rows: [row] } = await pool.query(`insert into github_wallet_link_challenges(nonce, github_user_id, github_login, wallet, created_at, expires_at)
        values ($1, $2, $3, $4, now(), now() + make_interval(secs => $5)) returning ${CHALLENGE_COLUMNS}`,
      [nonce, who.githubUserId, who.githubLogin, address, LINK_CHALLENGE_SECONDS])
      return { nonce, wallet: address, expiresAt: iso(row.expiresAt), message: contributorWalletMessage(row) }
    },

    // In one transaction: lock the challenge, check it and the signature, consume it, then write the link. A refusal rolls
    // everything back. Two accounts racing for one wallet: the unique index admits one; the other is refused.
    async link({ githubUserId, wallet, nonce, signature }) {
      const userId = githubUserIdOf(githubUserId), address = canonicalWallet(wallet)
      if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw fail('expired', 410)
      const client = await pool.connect()
      try {
        await client.query('begin')
        const { rows: [challenge] } = await client.query(`select ${CHALLENGE_COLUMNS}, now() as "now" from github_wallet_link_challenges
          where nonce = $1 for update`, [nonce])
        assertLinkable(challenge, { githubUserId: userId, wallet: address, signature }, challenge?.now)
        await client.query('update github_wallet_link_challenges set consumed_at = now() where nonce = $1', [nonce])
        const { rows: [owner] } = await client.query('select github_user_id::text as id from github_wallet_links where wallet = $1', [address])
        if (owner && owner.id !== userId) throw fail('taken', 409)
        const { rows: [row] } = await client.query(`insert into github_wallet_links(github_user_id, wallet, github_login) values ($1, $2, $3)
          on conflict (github_user_id) do update set wallet = excluded.wallet, github_login = excluded.github_login, updated_at = now(),
            linked_at = case when github_wallet_links.wallet = excluded.wallet then github_wallet_links.linked_at else now() end
          returning ${LINK_COLUMNS}`, [userId, address, challenge.githubLogin])
        await client.query('commit')
        return publicLink(row)
      } catch (error) {
        await client.query('rollback').catch(() => {})
        if (error?.code === '23505' && error.constraint === 'github_wallet_links_wallet_unique') throw fail('taken', 409)
        throw error
      } finally { client.release() }
    },

    // The signed-in account removes its own link (no wallet signature needed: removing a link moves nothing).
    async unlink({ githubUserId }) {
      const { rowCount } = await pool.query('delete from github_wallet_links where github_user_id = $1', [githubUserIdOf(githubUserId)])
      return { unlinked: rowCount === 1 }
    },
  }
}
