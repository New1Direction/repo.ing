import { randomBytes } from 'node:crypto'
import { CreditsWebError, INVALID_ANSWER, creditsCall, creditsOrigin, signInToCredits } from './credits-web.mjs'
import { creditsPacksSettings } from './credits-packs.mjs'
import { takeQuota } from './request-quota.mjs'

// "Make a key" on repo.ing/credits (docs/CREDITS_WEB.md, "Keys for your coding tool"): anyone signed in with GitHub sees their
// repo.ing AI credits, makes an inference-only key for a coding tool, sees their keys and revokes one, without the CLI
// (`repoing credits key|list|revoke`, cli/src/credits.mjs, whose shapes and checks these follow). The steps run on the
// credit service's own endpoints (/account, /keys, /keys/<id>/revoke) with the visitor's credit session from the encrypted
// cookie (src/credits-web.mjs). With no session, a click signs in again: a live GitHub check, then an identity handoff, as
// the credit packs do (src/credits-packs.mjs). A page load never signs in.
// repo.ing never stores or logs a key: it passes the one answer on and keeps nothing. Every answer is checked before it is shown.
// On with the credit packs (creditsPacksSettings): there is no switch of its own.
export const DEFAULT_INFERENCE_ORIGIN = 'https://inference.repo.ing'
export const MIN_LIMIT_MICRO = 10_000
export const DEFAULT_LABEL = 'coding-tool'
const MAX_KEYS = 50
const TOKEN = /^rik_[0-9a-f]{64}$/
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The credit service's own rule for a key's name.
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

/** The AI gateway a coding tool talks to (CREDITS_INFERENCE_ORIGIN, else the default): https, or http on this computer outside production. null if odd. */
export function inferenceOriginOf(env = process.env) {
  try { return creditsOrigin(env.CREDITS_INFERENCE_ORIGIN?.trim() || DEFAULT_INFERENCE_ORIGIN, env) } catch { return null }
}
/** The credit service settings with the AI gateway, or null while the credit packs are off (or the gateway origin is odd: the keys go dark, they are never pointed elsewhere). */
export function creditsKeysSettings(env = process.env) {
  const settings = creditsPacksSettings(env), inferenceOrigin = inferenceOriginOf(env)
  return settings && inferenceOrigin ? { ...settings, inferenceOrigin } : null
}

const usd = micro => `$${(Math.floor(micro / 10_000) / 100).toFixed(2)}`
const text = value => typeof value === 'string' ? value : ''
// A figure from the credit service: a whole number of micro-USD, as a number or as digits; null for anything else.
const microOf = value => {
  const number = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}
const dateOf = value => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : null }
const labelOf = value => LABEL.test(text(value)) ? value : '?'

/** The account's credits in micro-USD: credits_available, else paid_available (the CLI's rule). */
export function parseAccount(account) {
  const micro = account && typeof account === 'object' && !Array.isArray(account) ? microOf(account.credits_available ?? account.paid_available ?? 0) : null
  if (micro === null) throw new CreditsWebError('The AI credits service returned an invalid account.', 502)
  return micro
}

/** The account's keys, newest first as sent: a well-formed id is kept, the rest of the entry only as it is checked. No token field is ever passed on. */
export function parseKeys(value, now = Date.now()) {
  const keys = Array.isArray(value?.keys) ? value.keys : []
  return keys.filter(key => KEY_ID.test(text(key?.id))).slice(0, MAX_KEYS).map(key => {
    const expiresAt = dateOf(key.expires_at)
    const state = key.revoked || key.revoked_at ? 'revoked' : expiresAt !== null && Date.parse(expiresAt) <= now ? 'expired' : 'live'
    return { id: key.id.toLowerCase(), label: labelOf(key.label), budgetMicro: microOf(key.budget_micro ?? 0), spentMicro: microOf(key.spent_micro ?? 0), expiresAt, state }
  })
}

const invalidKey = () => new CreditsWebError('The AI credits service returned an invalid key. If a key was made, revoke it below.', 502)
/** A new key: the token and the key's id and limit, all well-formed, or an error that says to revoke it (it may have been made). */
export function parseMadeKey(answer) {
  const key = answer?.key
  if (!TOKEN.test(text(answer?.token)) || !KEY_ID.test(text(key?.id)) || !Number.isSafeInteger(key.budget_micro) || key.budget_micro < 0) {
    throw invalidKey()
  }
  return { token: answer.token, key: { id: key.id.toLowerCase(), label: labelOf(key.label), budgetMicro: key.budget_micro, expiresAt: dateOf(key.expires_at) } }
}

/** What a visitor sends. A name: the credit service's rule, default coding-tool. */
export function readLabel(value) {
  if (value === undefined) return DEFAULT_LABEL
  if (!LABEL.test(text(value))) throw new CreditsWebError('The name is 1 to 64 letters, digits, spaces, dots, dashes or underscores, and starts with a letter or digit.', 400)
  return value
}
/** A limit as whole micro-USD in text, at least $0.01; none (undefined) means all the credits. */
export function readLimit(value) {
  if (value === undefined) return null
  if (!/^[1-9]\d{0,14}$/.test(text(value)) || Number(value) < MIN_LIMIT_MICRO) throw new CreditsWebError('Enter a limit of at least $0.01.', 400)
  return Number(value)
}
export function readKeyId(value) {
  if (!KEY_ID.test(text(value))) throw new CreditsWebError('Unknown key.', 400)
  return value.toLowerCase()
}

// An answer that is not a refusal (a 5xx, or none at all) may come after the credit service made the key: say so. A 401 and a 4xx refusal mean nothing was made.
const mayHaveMade = error => {
  if (error instanceof CreditsWebError && !error.refused && error.status !== 401) error.message += ' A key may have been made: check your keys below first.'
  return error
}

/**
 * The key steps for one signed-in GitHub account. githubVerifier checks the account live (app/lib/github-session.mjs,
 * currentIdentity). current is the credit service's session from the cookie, or null. A step that signed in returns the new
 * session for the cookie (also on an error, as error.session: the sign-in is not wasted).
 */
export function createCreditsKeys({ pool, settings, githubVerifier, fetchImpl = fetch, now = () => Date.now() }) {
  const call = (path, options) => creditsCall(fetchImpl, settings.origin, path, options)
  const quota = async githubUserId => {
    if (!await takeQuota(pool, [[`credits:keys:${githubUserId}`, 20, 600], ['credits:keys', 300, 60]])) throw new CreditsWebError('Too many key requests. Wait a few minutes.', 429)
  }
  // The signed-in GitHub account, checked live (its token still works, for the same user); then an identity handoff, with no repository.
  const signIn = async ({ githubUserId, login }) => {
    const identity = await githubVerifier.currentIdentity().catch(() => {
      throw new CreditsWebError('Your GitHub sign-in expired. Sign in with GitHub again.', 403)
    })
    return signInToCredits({ pool, settings, repoId: null, permission: 'identity', githubUserId, login: identity.githubLogin ?? login, fetchImpl, now: now() })
  }
  // step(token) with the cookie's session; with none, or one the credit service no longer knows (a 401, once), with a new one.
  // beforeSignIn runs before every sign-in this makes (the first and the one after a 401), so a step that is not counted up front
  // can count there: nothing signs in without being counted.
  const withSession = async ({ githubUserId, login, current }, step, beforeSignIn = async () => {}) => {
    const signInAgain = async () => { await beforeSignIn(); return signIn({ githubUserId, login }) }
    let session = current ? null : await signInAgain()
    try {
      try { return { value: await step((session ?? current).token), session } } catch (error) {
        if (error?.status !== 401 || session) throw error
        session = await signInAgain()
        return { value: await step(session.token), session }
      }
    } catch (error) {
      if (session && error && typeof error === 'object') error.session = session
      throw error
    }
  }
  const read = async token => {
    const [account, keys] = await Promise.all([call('/account', { token }), call('/keys', { token })])
    return { needsSignIn: false, availableMicro: parseAccount(account), keys: parseKeys(keys, now()) }
  }
  return {
    /** The credits and keys. Never signs in: with no session (or one the credit service dropped) it says a click must. */
    async overview({ current }) {
      if (!current) return { needsSignIn: true }
      try { return await read(current.token) } catch (error) {
        if (error?.status === 401) return { needsSignIn: true }
        throw error
      }
    },
    /**
     * A click on "Show my AI credits": signs in if the cookie has no session or the credit service dropped it (a live GitHub check),
     * then the overview. Counted before each sign-in, and not at all when the session works.
     */
    async check({ githubUserId, login, current }) {
      const { value, session } = await withSession({ githubUserId, login, current }, read, () => quota(githubUserId))
      return { overview: value, session }
    },
    /**
     * One key: the balance is read again, the limit checked against it (all the credits when none is given), and one request made
     * with a fresh idempotency key. Returns the token for this one answer. Nothing runs after the key is made, so nothing can fail it.
     */
    async make({ githubUserId, login, current, label, limitMicro }) {
      const name = readLabel(label), wanted = readLimit(limitMicro)
      await quota(githubUserId)
      const { value, session } = await withSession({ githubUserId, login, current }, async token => {
        const available = parseAccount(await call('/account', { token }))
        if (available < MIN_LIMIT_MICRO) throw new CreditsWebError('You have no AI credits yet. Open a pack above first.', 400)
        const limit = wanted ?? available
        if (limit > available) throw new CreditsWebError(`The limit is at most ${usd(available)}, the credits you have.`, 400)
        const answer = await call('/keys', { method: 'POST', body: { label: name, budget_micro: limit }, token, idempotencyKey: randomBytes(16).toString('base64url') })
          // A 200 answer that is not an object is as bad as a malformed key: the key may have been made.
          .catch(error => { throw error?.message === INVALID_ANSWER ? invalidKey() : mayHaveMade(error) })
        return parseMadeKey(answer)
      })
      return { ...value, session }
    },
    /** Stops one key at once. The refreshed overview is asked for after, and is null if that did not answer (the revoke stands). */
    async revoke({ githubUserId, login, current, keyId }) {
      const id = readKeyId(keyId)
      await quota(githubUserId)
      const { session } = await withSession({ githubUserId, login, current }, token => call(`/keys/${id}/revoke`, { method: 'POST', body: {}, token }))
      return { overview: await read((session ?? current).token).catch(() => null), session }
    },
  }
}
