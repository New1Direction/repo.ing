import bs58 from 'bs58'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { HANDOFF_AUDIENCE, createHandoff, handoffEnabled } from './repo-inference-handoff.mjs'
import { takeQuota } from './request-quota.mjs'

// "Claim as AI credits" on the claim page (docs/CREDITS_WEB.md). The claim itself is unchanged: the server pays the bound
// wallet. Then the builder converts SOL from their own wallet into repo.ing AI credits (repo-inference, its
// docs/FEE-CONVERSION.md) with one wallet approval:
//   1. Quote. After a live GitHub admin check, repo.ing signs in to the credit service for the builder, server to server: it
//      makes the PKCE pair itself and approves its own handoff (the click is the consent; no code leaves the server). The
//      credit service's session token is kept only in an encrypted HttpOnly cookie. The quote is checked here: the pinned
//      treasury, the exact amount, one reference key, the expected network.
//   2. Prepare. A plain SOL transfer to the treasury with the quote's reference key (read-only, not a signer); the wallet
//      pays the fee. Its message is stored.
//   3. Submit. The signed bytes must be the stored message, signed by its payer. The signature is stored before the
//      broadcast. The credit ledger checks the payment on chain and credits it; this page asks for the quote's status.
// Dark unless CREDITS_WEB_CONVERT_ENABLED is exactly 'true', the sign-in handoff is on (src/repo-inference-handoff.mjs),
// REPO_INFERENCE_CREDITS_ORIGIN is the credit service and CREDITS_TREASURY_ADDRESS is its treasury.
export const MIN_LAMPORTS = 10_000_000n
export const MAX_LAMPORTS = 100_000_000_000n
export const OPEN_STATUSES = Object.freeze(['quoted', 'prepared', 'submitted'])
export const CREDITS_SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-repoing_credits' : 'repoing_credits'
// The credit service's session lives one hour; the cookie ends a little before it.
export const CREDITS_SESSION_SECONDS = 55 * 60
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const TOKEN = /^[\x21-\x7e]{16,1024}$/

export class CreditsWebError extends Error {
  constructor(message, status = 409) { super(message); this.name = 'CreditsWebError'; this.status = status }
}

/** The credit service: HTTPS; plain HTTP only on this computer outside production (tests). */
export function creditsOrigin(value, env = process.env) {
  const url = new URL(value)
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname) && env.NODE_ENV !== 'production'
  if (!(url.protocol === 'https:' || (local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search) {
    throw new Error('REPO_INFERENCE_CREDITS_ORIGIN must be an https origin.')
  }
  return url.origin
}

export function creditsWebSettings(env = process.env) {
  if (env.CREDITS_WEB_CONVERT_ENABLED !== 'true' || !handoffEnabled(env)) return null
  try {
    const network = env.CREDITS_WEB_NETWORK ?? 'mainnet'
    // devnet is for a local test against a staging credit service only: production always expects mainnet quotes.
    if (network !== 'mainnet' && (network !== 'devnet' || env.NODE_ENV === 'production')) return null
    return { origin: creditsOrigin(env.REPO_INFERENCE_CREDITS_ORIGIN, env), treasury: new PublicKey(env.CREDITS_TREASURY_ADDRESS).toBase58(), network }
  } catch { return null }
}
export const creditsWebEnabled = (env = process.env) => creditsWebSettings(env) !== null

/** "0.5" → 500000000n; at most 9 decimals. null for anything else. */
export function solToLamports(text) {
  const match = /^(\d{1,9})(?:\.(\d{1,9}))?$/.exec(String(text ?? ''))
  return match ? BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? '').padEnd(9, '0')) : null
}
export function readLamports(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,11}$/.test(value)) throw new CreditsWebError('Choose an amount of SOL.', 400)
  const lamports = BigInt(value)
  if (lamports < MIN_LAMPORTS || lamports > MAX_LAMPORTS) throw new CreditsWebError('A conversion is 0.01 to 100 SOL.', 400)
  return lamports
}

/** A Solana Pay transfer request: recipient, exact lamports and one reference key. Refuses SPL tokens and anything unknown. */
export function parseSolanaPay(value) {
  const match = typeof value === 'string' && value.length <= 1024 ? /^solana:([1-9A-HJ-NP-Za-km-z]{32,44})\?([^#\s]*)$/.exec(value) : null
  if (!match) throw new CreditsWebError('The credit service returned an invalid payment request.', 502)
  const params = new URLSearchParams(match[2])
  const keys = [...params.keys()]
  if (keys.some(key => !['amount', 'reference', 'label', 'message', 'memo'].includes(key)) || params.getAll('amount').length !== 1
    || params.getAll('reference').length !== 1 || params.has('memo')) {
    throw new CreditsWebError('The credit service returned an unexpected payment request.', 502)
  }
  const lamports = solToLamports(params.get('amount')), reference = params.get('reference')
  if (lamports === null || !BASE58.test(reference)) throw new CreditsWebError('The credit service returned an invalid payment request.', 502)
  return { recipient: new PublicKey(match[1]).toBase58(), lamports, reference: new PublicKey(reference).toBase58() }
}

/** A conversion quote from the credit service, checked against what was asked and this deployment's settings. */
export function parseQuote(quote, { settings, lamports, now = Date.now() }) {
  const expires = Date.parse(quote?.expires_at)
  if (!UUID.test(quote?.id ?? '') || !Number.isSafeInteger(quote.lamports) || BigInt(quote.lamports) !== BigInt(lamports)
    || !Number.isSafeInteger(quote.credit_micro) || quote.credit_micro <= 0 || !Number.isSafeInteger(quote.price_micro_per_sol)
    || quote.price_micro_per_sol <= 0 || !Number.isFinite(expires) || expires <= now || expires > now + 60 * 60_000) {
    throw new CreditsWebError('The credit service returned an invalid quote. Nothing was paid.', 502)
  }
  if (quote.network !== settings.network) throw new CreditsWebError(`The credit service quoted on ${String(quote.network).slice(0, 16)}, not ${settings.network}. Nothing was paid.`, 502)
  const pay = parseSolanaPay(quote.solana_pay_url)
  if (pay.recipient !== settings.treasury || pay.lamports !== BigInt(quote.lamports)) {
    throw new CreditsWebError('The quote does not pay the repo.ing credit treasury the quoted amount. Nothing was paid.', 502)
  }
  return { id: quote.id, lamports: String(quote.lamports), creditMicro: String(quote.credit_micro), priceMicroPerSol: String(quote.price_micro_per_sol),
    expiresAt: new Date(expires).toISOString(), reference: pay.reference, network: quote.network }
}

/** The one transfer a builder signs: payer → treasury, the quote's lamports, the reference key read-only. Unsigned. */
export function buildPayment({ payer, treasury, lamports, reference, blockhash, lastValidBlockHeight }) {
  const from = new PublicKey(payer)
  const instruction = SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(treasury), lamports: Number(lamports) })
  instruction.keys.push({ pubkey: new PublicKey(reference), isSigner: false, isWritable: false })
  const transaction = new Transaction({ feePayer: from, blockhash, lastValidBlockHeight }).add(instruction)
  return { message: transaction.serializeMessage().toString('base64'),
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }
}

/** The signed payment: exactly the prepared message, with one valid signature by its payer. */
export function assertPayment(signedTransaction, { message, payer }) {
  if (typeof signedTransaction !== 'string' || signedTransaction.length > 2000) throw new CreditsWebError('Invalid signed payment.', 400)
  let transaction
  try { transaction = Transaction.from(Buffer.from(signedTransaction, 'base64')) } catch { throw new CreditsWebError('Invalid signed payment.', 400) }
  if (!transaction.serializeMessage().equals(Buffer.from(message, 'base64')) || transaction.signatures.length !== 1
    || transaction.signatures[0].publicKey.toBase58() !== payer || !transaction.signature || !transaction.verifySignatures()) {
    throw new CreditsWebError('The wallet signed a different payment. Nothing was sent.', 400)
  }
  return { raw: transaction.serialize(), signature: bs58.encode(transaction.signature) }
}

// The credit service's session token, encrypted (AES-256-GCM, a key of its own from the GitHub App secret) and bound to
// the GitHub account it was made for. HttpOnly: it never reaches the page's scripts.
const sessionKey = secret => {
  if (!secret) throw new Error('GitHub App is not configured')
  return createHmac('sha256', secret).update('repo.ing credits session encryption v1').digest()
}
const AAD = Buffer.from('repo.ing credits session v1')
export function sealCreditsSession({ token, githubUserId, expiresAt }, secret = process.env.GITHUB_APP_CLIENT_SECRET) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', sessionKey(secret), iv)
  cipher.setAAD(AAD)
  const body = Buffer.concat([cipher.update(JSON.stringify({ token, githubUserId: String(githubUserId), expiresAt }), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}
/** The token for this GitHub account, or null (missing, tampered, expired or another account's). */
export function openCreditsSession(value, githubUserId, secret = process.env.GITHUB_APP_CLIENT_SECRET, now = Date.now()) {
  try {
    if (!value || value.length > 4096) return null
    const [version, iv, body, tag, extra] = value.split('.')
    if (version !== 'v1' || extra || !iv || !body || !tag) return null
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(secret), Buffer.from(iv, 'base64url'))
    decipher.setAAD(AAD)
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    const session = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'))
    if (session.githubUserId !== String(githubUserId) || !Number.isFinite(session.expiresAt) || session.expiresAt <= now
      || session.expiresAt > now + CREDITS_SESSION_SECONDS * 1000 || !TOKEN.test(session.token ?? '')) return null
    return session
  } catch { return null }
}

// One line of the credit service's own error text, for the builder; never more than 200 characters.
const plain = text => typeof text === 'string' && text.trim() ? text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200) : null
/** A JSON call to the credit service, server to server (no Origin header, no redirects, 15 s). */
export async function creditsCall(fetchImpl, origin, path, { method = 'GET', body, token, idempotencyKey } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetchImpl(`${origin}${path}`, { method, redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { 'user-agent': 'repo.ing-web', accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' },
        ...token ? { authorization: `Bearer ${token}` } : {}, ...idempotencyKey ? { 'idempotency-key': idempotencyKey } : {} },
      body: body === undefined ? undefined : JSON.stringify(body) })
    const value = await response.json().catch(() => null)
    if (!response.ok) throw new CreditsWebError(plain(value?.error) ?? `The AI credits service answered HTTP ${response.status}.`, response.status === 401 ? 401 : 502)
    if (!value || typeof value !== 'object') throw new CreditsWebError('The AI credits service returned an invalid answer.', 502)
    return value
  } catch (error) {
    if (error instanceof CreditsWebError) throw error
    throw new CreditsWebError('The AI credits service could not be reached. Try again in a minute.', 503)
  } finally { clearTimeout(timer) }
}

/**
 * Signs in to the credit service for a GitHub account that was just checked live as an admin of the repository: repo.ing
 * approves its own handoff (PKCE S256, the verifier never leaves this server) and the credit service redeems the code.
 */
export async function signInToCredits({ pool, settings, repoId, githubUserId, login, fetchImpl = fetch, now = Date.now() }) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const { code } = await createHandoff(pool, { request: { audience: HANDOFF_AUDIENCE, repoId: String(repoId), challenge }, githubUserId, login })
  const session = await creditsCall(fetchImpl, settings.origin, '/sessions', { method: 'POST', body: { code, code_verifier: verifier } })
  if (!TOKEN.test(session.token ?? '')) throw new CreditsWebError(plain(session.note) ?? 'The AI credits sign-in failed. Try again.', 502)
  const until = Date.parse(session.expires_at)
  const expiresAt = Math.min(now + CREDITS_SESSION_SECONDS * 1000, Number.isFinite(until) ? until - 60_000 : Infinity)
  return { token: session.token, githubUserId: String(githubUserId), expiresAt }
}

const publicConversion = row => row && ({ id: Number(row.id), status: row.status, lamports: String(row.lamports), creditMicro: String(row.credit_micro),
  priceMicroPerSol: String(row.price_micro_per_sol), expiresAt: new Date(row.expires_at).toISOString(), payer: row.payer_wallet ?? null,
  signature: row.payment_signature ?? null, creditedMicro: row.credited_micro == null ? null : String(row.credited_micro), network: row.network })
// The credit service's answer for a quote → this row's status. Unknown answers change nothing.
export function outcomeOf(quote) {
  if (quote?.status === 'credited' && Number.isSafeInteger(quote.credit_micro)) return { status: 'credited', creditedMicro: quote.credit_micro }
  if (quote?.review_pending === true) return { status: 'review' }
  if (quote?.status === 'expired') return { status: 'expired' }
  return null
}

/**
 * The conversion steps for one signed-in builder. githubVerifier checks admin authority live (app/lib/github-session.mjs);
 * session is the credit service's session from the cookie, or null.
 */
export function createCreditsConvert({ pool, connection, settings, githubVerifier, fetchImpl = fetch, now = () => Date.now() }) {
  const owned = async (id, githubUserId) => {
    const { rows: [row] } = await pool.query('select * from credit_conversions where id=$1 and github_user_id=$2', [id, githubUserId])
    if (!row) throw new CreditsWebError('Unknown conversion.', 404)
    return row
  }
  // A live admin check, then a new credit service session (the cookie's is missing, expired or refused).
  const signIn = async ({ repoId, githubUserId, login }) => {
    const admin = await githubVerifier.verifyCurrentAuthority({ githubRepoId: repoId }).catch(() => {
      throw new CreditsWebError('GitHub no longer lists you as an admin of this repository. Verify again.', 403)
    })
    const githubLogin = admin.githubLogin ?? login
    return { login: githubLogin, session: await signInToCredits({ pool, settings, repoId, githubUserId, login: githubLogin, fetchImpl, now: now() }) }
  }
  const expire = async (row, statuses) => (await pool.query(`update credit_conversions set status='expired',updated_at=now()
    where id=$1 and status = any($2::text[]) returning *`, [row.id, statuses])).rows[0] ?? row
  const refresh = async (row, token) => {
    if (!OPEN_STATUSES.includes(row.status)) return row
    const outcome = token ? outcomeOf(await creditsCall(fetchImpl, settings.origin, `/quotes/${row.quote_id}`, { token }).catch(() => null)) : null
    if (outcome && outcome.status !== 'expired') {
      const { rows: [next] } = await pool.query(`update credit_conversions set status=$2,credited_micro=$3,updated_at=now()
        where id=$1 and status in ('quoted','prepared','submitted') returning *`, [row.id, outcome.status, outcome.creditedMicro ?? null])
      return next ?? row
    }
    if (new Date(row.expires_at).getTime() > now()) return row
    if (row.status !== 'submitted') return expire(row, ['quoted', 'prepared'])
    // A signed payment is written off only when the chain shows it can no longer land; otherwise the ledger credits it
    // late or sends it to review, and this row follows.
    const [status, height] = await Promise.all([connection.getSignatureStatuses([row.payment_signature], { searchTransactionHistory: true })
      .then(r => r.value[0]).catch(() => undefined), connection.getBlockHeight('confirmed').catch(() => null)])
    return status === null && height > Number(row.last_valid_block_height) ? expire(row, ['submitted']) : row
  }
  return {
    /**
     * The builder's latest conversion on this repository, its status asked again while it is open. Without a session, an open
     * conversion signs in again (a live admin check) at most once a minute; `session` is then the one to keep.
     */
    async status({ repoId, githubUserId, login, current }) {
      const { rows: [row] } = await pool.query(`select * from credit_conversions where github_user_id=$1 and github_repo_id=$2
        order by id desc limit 1`, [githubUserId, repoId])
      let kept = current
      if (row && OPEN_STATUSES.includes(row.status) && !kept && await takeQuota(pool, [[`credits:status-sign-in:${githubUserId}`, 1, 60]])) {
        kept = await signIn({ repoId, githubUserId, login }).then(result => result.session).catch(() => null)
      }
      return { conversion: publicConversion(row ? await refresh(row, kept?.token) : null), session: kept !== current ? kept : null }
    },
    /** A quote for `lamports`, after a live admin check. Returns the conversion and the session to keep. */
    async quote({ repoId, githubUserId, login, lamports, current }) {
      const amount = readLamports(lamports)
      if (!await takeQuota(pool, [[`credits:quote:${githubUserId}`, 6, 600], ['credits:quote', 300, 60]])) throw new CreditsWebError('Too many quotes. Wait a few minutes.', 429)
      const open = (await pool.query(`select * from credit_conversions where github_user_id=$1 and status = any($2::text[])`, [githubUserId, OPEN_STATUSES])).rows[0]
      if (open && OPEN_STATUSES.includes((await refresh(open, current?.token)).status)) throw new CreditsWebError('You have an open conversion. Finish or cancel it first.')
      // Every quote checks admin authority live, even with a session in the cookie.
      const fresh = await signIn({ repoId, githubUserId, login })
      const ask = session => creditsCall(fetchImpl, settings.origin, '/quotes', { method: 'POST', body: { lamports: amount.toString() },
        token: session.token, idempotencyKey: randomBytes(16).toString('base64url') })
      const quote = parseQuote(await ask(fresh.session), { settings, lamports: amount, now: now() })
      let row
      try {
        row = (await pool.query(`insert into credit_conversions(github_repo_id,github_user_id,github_login,quote_id,lamports,credit_micro,
          price_micro_per_sol,reference,network,expires_at,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'quoted') returning *`,
        [repoId, githubUserId, fresh.login, quote.id, quote.lamports, quote.creditMicro, quote.priceMicroPerSol, quote.reference, quote.network, quote.expiresAt])).rows[0]
      } catch (error) {
        if (error?.code === '23505') throw new CreditsWebError('You have an open conversion. Finish or cancel it first.')
        throw error
      }
      return { conversion: publicConversion(row), session: fresh.session }
    },
    /** The unsigned transfer for this quote, from `payer`. Again after a broadcast that expired without landing. */
    async prepare({ id, githubUserId, payer }) {
      if (typeof payer !== 'string' || !BASE58.test(payer)) throw new CreditsWebError('Connect a Solana wallet.', 400)
      let row = await owned(id, githubUserId)
      if (new Date(row.expires_at).getTime() <= now() + 30_000) throw new CreditsWebError('This quote expired. Get a new one.')
      if (row.status === 'submitted') {
        // A signed payment that never landed and whose blockhash has expired can be replaced; anything else waits.
        const [status, height] = await Promise.all([connection.getSignatureStatuses([row.payment_signature], { searchTransactionHistory: true }).then(r => r.value[0]),
          connection.getBlockHeight('confirmed')])
        if (status || !(height > Number(row.last_valid_block_height))) throw new CreditsWebError('Your payment is on its way. Wait for it before approving again.')
        row = (await pool.query(`update credit_conversions set status='prepared',payment_signature=null,earlier_signatures=earlier_signatures||$2::text[],
          updated_at=now() where id=$1 and status='submitted' returning *`, [row.id, [row.payment_signature]])).rows[0]
        if (!row) throw new CreditsWebError('This conversion changed. Refresh and try again.')
      }
      if (!['quoted', 'prepared'].includes(row.status)) throw new CreditsWebError('This conversion is closed.')
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const payment = buildPayment({ payer: new PublicKey(payer).toBase58(), treasury: settings.treasury, lamports: row.lamports,
        reference: row.reference, blockhash, lastValidBlockHeight })
      const { rows: [prepared] } = await pool.query(`update credit_conversions set status='prepared',payer_wallet=$2,prepared_message=$3,
        last_valid_block_height=$4,updated_at=now() where id=$1 and status in ('quoted','prepared') returning *`, [row.id, new PublicKey(payer).toBase58(), payment.message, lastValidBlockHeight])
      if (!prepared) throw new CreditsWebError('This conversion changed. Refresh and try again.')
      return { conversion: publicConversion(prepared), transaction: payment.transaction }
    },
    /** The wallet's signature over the prepared transfer: stored, then broadcast once (with preflight). */
    async submit({ id, githubUserId, signedTransaction }) {
      const row = await owned(id, githubUserId)
      if (row.status !== 'prepared' || !row.prepared_message) throw new CreditsWebError('This conversion is not waiting for a payment.')
      if (new Date(row.expires_at).getTime() <= now()) throw new CreditsWebError('This quote expired. Get a new one.')
      const payment = assertPayment(signedTransaction, { message: row.prepared_message, payer: row.payer_wallet })
      const { rows: [submitted] } = await pool.query(`update credit_conversions set status='submitted',payment_signature=$2,submitted_at=now(),
        updated_at=now() where id=$1 and status='prepared' and prepared_message=$3 returning *`, [row.id, payment.signature, row.prepared_message])
      if (!submitted) throw new CreditsWebError('This conversion changed. Refresh and try again.')
      try { await connection.sendRawTransaction(payment.raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }) } catch (error) {
        // A failed preflight sends nothing: the conversion waits for a new approval. Any other error may have sent it.
        if (!/simulation failed|insufficient|Attempt to debit/i.test(String(error?.message))) return { conversion: publicConversion(submitted) }
        await pool.query(`update credit_conversions set status='prepared',payment_signature=null,updated_at=now() where id=$1 and status='submitted'`, [row.id])
        throw new CreditsWebError(/insufficient|Attempt to debit/i.test(String(error?.message))
          ? 'Your wallet does not hold enough SOL for this amount and the network fee. Choose a smaller amount.' : 'The payment failed its check. Nothing was sent.')
      }
      return { conversion: publicConversion(submitted) }
    },
    /** A quote or an unsigned transfer can be dropped; a signed payment cannot. */
    async cancel({ id, githubUserId }) {
      await owned(id, githubUserId)
      const { rows: [row] } = await pool.query(`update credit_conversions set status='cancelled',updated_at=now() where id=$1 and status in ('quoted','prepared') returning *`, [id])
      if (!row) throw new CreditsWebError('A signed payment cannot be cancelled. Wait for its status.')
      return { conversion: publicConversion(row) }
    },
  }
}
