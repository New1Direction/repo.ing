import { HfAuthorityError, createHfOAuth, createHfVerifier, hfOAuthConfig } from '../../src/hf-verification.mjs'
import { hfClient } from './hf-client.mjs'
import { database } from './server.mjs'
import { publicOrigin } from './origin.mjs'

// Web wiring for Hugging Face sign-in and model authority (src/hf-verification.mjs), the counterpart of
// app/lib/github-session.mjs. Model and owner reads use the process's one anonymous Hub client (app/lib/hf-client.mjs,
// shared with launches, so its rate-limit pacing covers every request). OAuth calls go through globalThis.fetch at call time.
const lateFetch = (url, init) => globalThis.fetch(url, init)

// The OAuth client, or a clean refusal while HF_OAUTH_* is unset or its redirect URI is not this origin's callback.
export function hfOAuth(requestUrl) {
  const config = hfOAuthConfig()
  if (!config || (requestUrl && new URL(config.redirectUri).origin !== publicOrigin(requestUrl))) {
    throw new HfAuthorityError('HF_NOT_CONFIGURED', 'Hugging Face sign-in is not configured.', 503)
  }
  return createHfOAuth({ ...config, fetchImpl: lateFetch })
}

export function hfVerifier(requestUrl) {
  const pool = database()
  if (!pool) throw new HfAuthorityError('HF_NOT_CONFIGURED', 'Hugging Face sign-in is not configured.', 503)
  return createHfVerifier({ pool, hf: hfClient(), oauth: hfOAuth(requestUrl) })
}

// The payout authority of one signed-in session for its model market: what src/claim.mjs (as its verifier) and
// src/payout-address.mjs (as verifyAuthority) call before anything changes. source tells them it is not GitHub's.
export function hfSessionAuthority(session, requestUrl) {
  const verifier = hfVerifier(requestUrl)
  async function verifyCurrentAuthority({ githubRepoId }) {
    if (!session || session.expiresAt <= Date.now()) throw new HfAuthorityError('HF_SESSION_EXPIRED', 'Your Hugging Face session expired. Sign in again.', 401)
    if (session.mode !== 'claim' || session.marketId !== String(githubRepoId)) {
      throw new HfAuthorityError('HF_SESSION_MISMATCH', 'This Hugging Face session is for another page. Sign in again here.', 403)
    }
    return verifier.verifyMarketAuthority({ marketId: githubRepoId, accessToken: session.accessToken, expectedSubject: session.subject })
  }
  const verifyAuthority = Object.assign(input => verifyCurrentAuthority(input), { source: 'huggingface' })
  return { source: 'huggingface', verifyCurrentAuthority, verifyAuthority, verifier }
}

// Routes answer with app-authored messages only: Hugging Face authority errors and the caller's own error classes keep
// their message and status; anything else (database, RPC, transport) is logged and replaced.
export function hfRouteError(error, { known = [], fallback, context }) {
  if (error instanceof HfAuthorityError) return { status: error.status, body: { error: error.message, code: error.code } }
  const own = known.find(type => error instanceof type)
  if (own) return { status: error.status ?? 400, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } }
  console.error(`${context} failed`, { error: error?.message ?? String(error) })
  return { status: 503, body: { error: fallback } }
}
