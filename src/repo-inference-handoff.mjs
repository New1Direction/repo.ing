import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isGithubRepoId } from './market-identity.mjs'

// The sign-in handoff for repo.ing AI credits (repo-inference, its docs/FEE-CONVERSION.md): `repoing claim` asks repo.ing
// to confirm that the person at the keyboard is an admin of a repository, without giving the credit service a GitHub token
// or a session. OAuth-style with PKCE:
//   1. The CLI opens /api/handoff/start with the repository, a code challenge (S256), its loopback port and a state.
//   2. The builder signs in with GitHub (identity) and approves on /handoff; repo.ing checks admin live and sends a single-
//      use code (3 minutes) to http://127.0.0.1:<port>/callback.
//   3. The credit service redeems the code with the CLI's code verifier and its client secret (/api/handoff/token). The
//      answer is signed with HANDOFF_ASSERTION_SECRET, which only repo.ing and the credit ledger hold, so the credit
//      service can relay an assertion but never make one.
// Dark unless REPO_INFERENCE_HANDOFF_ENABLED is exactly 'true' (off by default: owner decision 2026-10-08, hidden until AI credits
// start) and REPO_INFERENCE_HANDOFF_SECRET and HANDOFF_ASSERTION_SECRET are set (32 to 256 characters, different from each other
// and from the GitHub App secret). Secrets alone never turn it on.
export const HANDOFF_AUDIENCE = 'repo-inference'
export const HANDOFF_AUDIENCE_LABEL = 'repo.ing AI credits'
export const HANDOFF_CODE_SECONDS = 180
export const HANDOFF_REQUEST_SECONDS = 600
export const HANDOFF_REFUSED = 'The sign-in expired or was already used. Run repoing claim again.'

const B64URL = /^[A-Za-z0-9_-]+$/
export class HandoffError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'HandoffError'; this.status = status }
}

export function handoffSettings(env = process.env) {
  if (env.REPO_INFERENCE_HANDOFF_ENABLED !== 'true') return null
  const clientSecret = env.REPO_INFERENCE_HANDOFF_SECRET, assertionSecret = env.HANDOFF_ASSERTION_SECRET
  const ok = value => typeof value === 'string' && value.length >= 32 && value.length <= 256
  if (!ok(clientSecret) || !ok(assertionSecret) || clientSecret === assertionSecret || [clientSecret, assertionSecret].includes(env.GITHUB_APP_CLIENT_SECRET)) return null
  return { clientSecret, assertionSecret }
}
export const handoffEnabled = (env = process.env) => handoffSettings(env) !== null

/** The CLI's request: audience, repository, S256 challenge, loopback port and state; anything else is refused. */
export function readHandoffRequest(params) {
  const value = name => typeof params?.get === 'function' ? params.get(name) : params?.[name]
  const audience = value('audience'), repoId = value('repo'), challenge = value('challenge'), port = Number(value('port')), state = value('state')
  if (audience !== HANDOFF_AUDIENCE) throw new HandoffError('Unknown sign-in audience.')
  if (typeof repoId !== 'string' || !/^[1-9]\d{0,18}$/.test(repoId) || !isGithubRepoId(repoId)) throw new HandoffError('Unknown repository.')
  if (typeof challenge !== 'string' || challenge.length !== 43 || !B64URL.test(challenge)) throw new HandoffError('Invalid code challenge.')
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || String(port) !== value('port')) throw new HandoffError('Invalid loopback port.')
  if (typeof state !== 'string' || state.length < 16 || state.length > 128 || !B64URL.test(state)) throw new HandoffError('Invalid state.')
  return { audience, repoId, challenge, port, state }
}
/** Where the browser goes back to the CLI: only the loopback address, with the code or the refusal and the state. */
export function callbackUrl(request, result) {
  const url = new URL(`http://127.0.0.1:${request.port}/callback`)
  if (result.code) url.searchParams.set('code', result.code)
  else url.searchParams.set('error', result.error ?? 'access_denied')
  url.searchParams.set('state', request.state)
  return url.href
}

// A short code made from the CLI's challenge, shown both in the terminal and on the consent page, so the builder approves the
// sign-in they started (cli/src/claim.mjs makes the same code). Letters and digits that cannot be confused with each other.
const CHECK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function handoffCheckCode(challenge) {
  const digest = createHash('sha256').update(`repoing-handoff-check\n${challenge}`).digest()
  const letters = [...digest.subarray(0, 8)].map(byte => CHECK_ALPHABET[byte % 32]).join('')
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}
export const challengeHash = challenge => createHash('sha256').update(String(challenge)).digest('hex')

/** The text repo.ing signs and the credit ledger checks (repo-inference: src/conversion.rs, assertion_message). */
export function assertionMessage({ handoffId, githubUserId, login, repoId, permission, verifiedAt }) {
  return ['repoing-handoff-v1', HANDOFF_AUDIENCE, handoffId, githubUserId, login, repoId, permission, verifiedAt].join('\n')
}
export function signAssertion(secret, facts) {
  return createHmac('sha256', secret).update(assertionMessage(facts)).digest('hex')
}
const sha256 = value => createHash('sha256').update(value).digest('hex')
const s256 = verifier => createHash('sha256').update(verifier).digest('base64url')
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
/** Whether the presented client secret is the configured one (constant time). */
export const clientAuthorized = (authorization, settings) => sameText(authorization, `Bearer ${settings.clientSecret}`)

/** An approved handoff: a single-use code for the CLI (only its hash is stored). Rows older than a day are deleted. */
export async function createHandoff(pool, { request, githubUserId, login, verifiedAt = new Date() }) {
  await pool.query(`delete from auth_handoffs where expires_at < now() - interval '1 day'`)
  if (!/^[1-9]\d{0,18}$/.test(String(githubUserId)) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login ?? '')) throw new HandoffError('Invalid GitHub account.')
  const code = randomBytes(32).toString('base64url'), handoffId = randomBytes(18).toString('base64url')
  await pool.query(`insert into auth_handoffs(handoff_id,code_hash,audience,github_repo_id,github_user_id,github_login,code_challenge,verified_at,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(secs=>$9))`,
  [handoffId, sha256(code), request.audience, request.repoId, String(githubUserId), login, request.challenge, verifiedAt, HANDOFF_CODE_SECONDS])
  return { code, handoffId }
}
/**
 * Redeems a code once, atomically: the first redemption consumes it, whatever happens next. The code verifier must match
 * the challenge (PKCE S256). null for an unknown, expired, used or mismatched code.
 */
export const redemptionWellFormed = ({ audience, code, codeVerifier }) => audience === HANDOFF_AUDIENCE && typeof code === 'string' && code.length === 43
  && B64URL.test(code) && typeof codeVerifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)
export const codeHash = code => sha256(code)
export async function redeemHandoff(pool, { audience, code, codeVerifier }, settings) {
  if (!redemptionWellFormed({ audience, code, codeVerifier })) return null
  const { rows: [row] } = await pool.query(`update auth_handoffs set consumed_at=now() where code_hash=$1 and audience=$2 and consumed_at is null
    and expires_at>now() returning handoff_id as "handoffId",github_repo_id::text as "repoId",github_user_id::text as "githubUserId",
    github_login as login,code_challenge as challenge,verified_at as "verifiedAt"`, [sha256(code), audience])
  if (!row || !sameText(s256(codeVerifier), row.challenge)) return null
  const facts = { handoffId: row.handoffId, githubUserId: row.githubUserId, login: row.login, repoId: row.repoId, permission: 'admin',
    verifiedAt: new Date(row.verifiedAt).toISOString() }
  return { audience, handoff_id: facts.handoffId, github_user_id: facts.githubUserId, login: facts.login, repo_id: facts.repoId,
    permission: facts.permission, verified_at: facts.verifiedAt, signature: signAssertion(settings.assertionSecret, facts) }
}
