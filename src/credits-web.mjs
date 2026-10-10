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
//   3. Submit. The signed bytes must be the stored message, signed by its payer, and pass a simulation. The signature is
//      stored before the broadcast; from then on only the chain reopens the quote (a payment that failed, or that can no
//      longer land). The credit ledger checks the payment on chain and credits it; this page asks for the quote's status.
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
  signature: row.payment_signature ?? null, creditedMicro: row.credited_micro == null ? null : String(row.credited_micro), network: row.network,
  repoId: String(row.github_repo_id) })
// The credit service's answer for a quote → this row's status. Unknown answers change nothing.
export function outcomeOf(quote) {
  if (quote?.status === 'credited' && Number.isSafeInteger(quote.credit_micro) && quote.credit_micro > 0) return { status: 'credited', creditedMicro: quote.credit_micro }
  if (quote?.review_pending === true) return { status: 'review' }
  if (quote?.status === 'expired') return { status: 'expired' }
  return null
}
// A system transfer leaves the payer empty, or with at least the rent-exempt minimum; the fee is one signature.
const FEE_LAMPORTS = 5_000n, RENT_EXEMPT_LAMPORTS = 890_880n
export function affordable(balance, lamports) {
  const left = BigInt(balance) - BigInt(lamports) - FEE_LAMPORTS
  return left === 0n || left >= RENT_EXEMPT_LAMPORTS
}
const sol = lamports => {
  const value = BigInt(lamports), part = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '')
  return `${value / 1_000_000_000n}${part ? `.${part}` : ''}`
}
// A simulation that failed for want of SOL: the transfer's own error, or the fee or rent checks.
const lacksSol = value => /Insufficient|AccountNotFound|"Custom":1\b/.test(JSON.stringify(value?.err ?? null))
  || (value?.logs ?? []).some(line => /insufficient lamports/i.test(line))

/**
 * The conversion steps for one signed-in builder. githubVerifier checks admin authority live (app/lib/github-session.mjs);
 * current is the credit service's session from the cookie, or null.
 */
export function createCreditsConvert({ pool, connection, settings, githubVerifier, fetchImpl = fetch, now = () => Date.now() }) {
  const owned = async (id, githubUserId) => {
    const { rows: [row] } = await pool.query('select * from credit_conversions where id=$1 and github_user_id=$2', [id, githubUserId])
    if (!row) throw new CreditsWebError('Unknown conversion.', 404)
    return row
  }
  // A live admin check, then a new credit service session. Only from a click (POST): a page load never signs in.
  const signIn = async ({ repoId, githubUserId, login }) => {
    const admin = await githubVerifier.verifyCurrentAuthority({ githubRepoId: repoId }).catch(() => {
      throw new CreditsWebError('GitHub no longer lists you as an admin of this repository. Verify again.', 403)
    })
    const githubLogin = admin.githubLogin ?? login
    return { login: githubLogin, session: await signInToCredits({ pool, settings, repoId, githubUserId, login: githubLogin, fetchImpl, now: now() }) }
  }
  const set = async (row, status, from, creditedMicro = null) => (await pool.query(`update credit_conversions set status=$2,credited_micro=$3,updated_at=now()
    where id=$1 and status = any($4::text[]) returning *`, [row.id, status, creditedMicro, from])).rows[0] ?? row
  // Where the signed payment is: 'landed', 'failed' (landed with an error: the fee was spent, nothing was paid), 'lost' (not
  // found, and its blockhash has expired, so it can never land) or 'pending'.
  const chainStatus = async row => {
    const [status, height] = await Promise.all([connection.getSignatureStatuses([row.payment_signature], { searchTransactionHistory: true }).then(r => r.value[0]),
      connection.getBlockHeight('confirmed')])
    if (status?.err) return 'failed'
    if (status) return 'landed'
    return height > Number(row.last_valid_block_height) ? 'lost' : 'pending'
  }
  // A failed or lost payment: its signature is kept, and the quote can be paid again while it lasts.
  const retry = async row => (await pool.query(`update credit_conversions set status=$2,payment_signature=null,earlier_signatures=earlier_signatures||$3::text[],
    updated_at=now() where id=$1 and status='submitted' and payment_signature=$4 returning *`,
  [row.id, new Date(row.expires_at).getTime() > now() ? 'prepared' : 'expired', [row.payment_signature], row.payment_signature])).rows[0] ?? row
  const refresh = async (row, token) => {
    if (!OPEN_STATUSES.includes(row.status)) return row
    const outcome = token ? outcomeOf(await creditsCall(fetchImpl, settings.origin, `/quotes/${row.quote_id}`, { token }).catch(() => null)) : null
    if (outcome && outcome.status !== 'expired') return set(row, outcome.status, OPEN_STATUSES, outcome.creditedMicro ?? null)
    if (row.status === 'submitted') {
      const chain = await chainStatus(row).catch(() => 'pending')
      if (chain === 'failed' || chain === 'lost') return retry(row)
      // A payment that landed for a quote the credit service has closed: a person reviews it (a refund, or credits).
      if (chain === 'landed' && outcome?.status === 'expired') return set(row, 'review', ['submitted'])
      return row
    }
    return outcome?.status === 'expired' || new Date(row.expires_at).getTime() <= now() ? set(row, 'expired', ['quoted', 'prepared']) : row
  }
  return {
    /**
     * The account's open conversion (whichever repository it started on), else its latest on this repository, asked again
     * while it is open. Never signs in: needsSignIn says a click (check) must sign in to ask the credit service.
     */
    async status({ repoId, githubUserId, current }) {
      const { rows: [row] } = await pool.query(`select * from credit_conversions where github_user_id=$1 and (github_repo_id=$2 or status = any($3::text[]))
        order by (status = any($3::text[])) desc, id desc limit 1`, [githubUserId, repoId, OPEN_STATUSES])
      if (!row) return { conversion: null, needsSignIn: false }
      const fresh = await refresh(row, current?.token)
      return { conversion: publicConversion(fresh), needsSignIn: OPEN_STATUSES.includes(fresh.status) && !current }
    },
    /** A click on "Refresh status": signs in again if the session is gone (a live admin check), then asks again. */
    async check({ id, repoId, githubUserId, login, current }) {
      const row = await owned(id, githubUserId)
      let session = null
      if (OPEN_STATUSES.includes(row.status) && !current) {
        if (!await takeQuota(pool, [[`credits:check:${githubUserId}`, 10, 600]])) throw new CreditsWebError('Too many checks. Wait a few minutes.', 429)
        session = (await signIn({ repoId, githubUserId, login })).session
      }
      return { conversion: publicConversion(await refresh(row, (current ?? session)?.token)), session }
    },
    /** A quote for `lamports`, after a live admin check; with `payer`, only an amount that wallet can pay. */
    async quote({ repoId, githubUserId, login, lamports, payer = null, current }) {
      const amount = readLamports(lamports)
      if (payer !== null && (typeof payer !== 'string' || !BASE58.test(payer))) throw new CreditsWebError('Invalid wallet.', 400)
      if (!await takeQuota(pool, [[`credits:quote:${githubUserId}`, 6, 600], ['credits:quote', 300, 60]])) throw new CreditsWebError('Too many quotes. Wait a few minutes.', 429)
      const open = (await pool.query(`select * from credit_conversions where github_user_id=$1 and status = any($2::text[])`, [githubUserId, OPEN_STATUSES])).rows[0]
      if (open && OPEN_STATUSES.includes((await refresh(open, current?.token)).status)) throw new CreditsWebError('You have an open conversion. Finish or cancel it first.')
      if (payer !== null) {
        const balance = BigInt(await connection.getBalance(new PublicKey(payer), 'confirmed'))
        if (!affordable(balance, amount)) {
          const most = balance - FEE_LAMPORTS - RENT_EXEMPT_LAMPORTS
          throw new CreditsWebError(`Your wallet holds ${sol(balance)} SOL. Choose ${most >= MIN_LAMPORTS ? `at most ${sol(most)} SOL` : 'a wallet with more SOL'}, so the network fee is covered.`, 400)
        }
      }
      // Every quote checks admin authority live, even with a session in the cookie.
      const fresh = await signIn({ repoId, githubUserId, login })
      const quote = parseQuote(await creditsCall(fetchImpl, settings.origin, '/quotes', { method: 'POST', body: { lamports: amount.toString() },
        token: fresh.session.token, idempotencyKey: randomBytes(16).toString('base64url') }), { settings, lamports: amount, now: now() })
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
    /** The unsigned transfer for this quote, from `payer`. Again after a payment that failed on chain or can no longer land. */
    async prepare({ id, githubUserId, payer }) {
      if (typeof payer !== 'string' || !BASE58.test(payer)) throw new CreditsWebError('Connect a Solana wallet.', 400)
      let row = await owned(id, githubUserId)
      if (row.status === 'submitted') {
        if (['landed', 'pending'].includes(await chainStatus(row))) throw new CreditsWebError('Your payment is on its way. Wait for it before approving again.')
        row = await retry(row)
      }
      if (!['quoted', 'prepared'].includes(row.status)) throw new CreditsWebError(row.status === 'expired' ? 'This quote expired. Get a new one.' : 'This conversion is closed.')
      if (new Date(row.expires_at).getTime() <= now() + 30_000) throw new CreditsWebError('This quote is about to expire. Get a new one.')
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const wallet = new PublicKey(payer).toBase58()
      const payment = buildPayment({ payer: wallet, treasury: settings.treasury, lamports: row.lamports, reference: row.reference, blockhash, lastValidBlockHeight })
      const { rows: [prepared] } = await pool.query(`update credit_conversions set status='prepared',payer_wallet=$2,prepared_message=$3,
        last_valid_block_height=$4,updated_at=now() where id=$1 and status in ('quoted','prepared') returning *`, [row.id, wallet, payment.message, lastValidBlockHeight])
      if (!prepared) throw new CreditsWebError('This conversion changed. Refresh and try again.')
      return { conversion: publicConversion(prepared), transaction: payment.transaction }
    },
    /**
     * The wallet's signature over the prepared transfer. It is simulated first: a payment that cannot succeed is refused
     * before anything is stored or sent. Then the signature is stored and the payment broadcast. From the broadcast on, any
     * error may mean it was sent: the row stays submitted, and only the chain (failed, or lost after its blockhash) reopens it.
     */
    async submit({ id, githubUserId, signedTransaction }) {
      const row = await owned(id, githubUserId)
      if (row.status !== 'prepared' || !row.prepared_message) throw new CreditsWebError('This conversion is not waiting for a payment.')
      if (new Date(row.expires_at).getTime() <= now() + 15_000) throw new CreditsWebError('This quote is about to expire. Nothing was sent; get a new one.')
      const payment = assertPayment(signedTransaction, { message: row.prepared_message, payer: row.payer_wallet })
      const simulation = await connection.simulateTransaction(Transaction.from(payment.raw)).catch(() => null)
      if (!simulation?.value) throw new CreditsWebError('The payment could not be checked. Nothing was sent; try again.', 503)
      if (simulation.value.err) {
        throw new CreditsWebError(lacksSol(simulation.value) ? 'Your wallet does not hold enough SOL for this amount and the network fee. Nothing was sent.'
          : 'The payment failed its check. Nothing was sent.')
      }
      const { rows: [submitted] } = await pool.query(`update credit_conversions set status='submitted',payment_signature=$2,submitted_at=now(),
        updated_at=now() where id=$1 and status='prepared' and prepared_message=$3 returning *`, [row.id, payment.signature, row.prepared_message])
      if (!submitted) throw new CreditsWebError('This conversion changed. Refresh and try again.')
      await connection.sendRawTransaction(payment.raw, { skipPreflight: true, maxRetries: 5 }).catch(() => {})
      return { conversion: publicConversion(submitted) }
    },
    /** A quote, an unsigned transfer, or a payment that failed or can no longer land can be dropped; a pending one cannot. */
    async cancel({ id, githubUserId }) {
      let row = await owned(id, githubUserId)
      if (row.status === 'submitted') row = await refresh(row, null)
      const { rows: [cancelled] } = await pool.query(`update credit_conversions set status='cancelled',updated_at=now() where id=$1 and status in ('quoted','prepared') returning *`, [row.id])
      if (!cancelled) throw new CreditsWebError(row.status === 'submitted' ? 'A payment on its way cannot be cancelled. Wait for its status.' : 'This conversion is closed.')
      return { conversion: publicConversion(cancelled) }
    },
  }
}
