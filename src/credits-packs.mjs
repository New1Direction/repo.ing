import { createHash, randomBytes } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { CreditsWebError, FEE_LAMPORTS, MAX_LAMPORTS, MIN_LAMPORTS, RENT_EXEMPT_LAMPORTS, affordable, assertPayment, broadcast, buildPayment, chainStatus,
  creditsCall, creditsServiceSettings, parseSolanaPay, signInToCredits, simulatePayment, sol } from './credits-web.mjs'
import { takeQuota } from './request-quota.mjs'
import { builderShareTarget, shareMicro } from './builder-pack-shares.mjs'
import { packBuilderTicket } from './credits-tickets.mjs'

// AI credit packs on repo.ing/credits (docs/CREDITS_WEB.md, "Credit packs"): anyone with a GitHub account buys a $10, $25, $50 or $100 pack of
// repo.ing AI credits with SOL from their own wallet, and the pack's one spin (repo-inference docs/PACKS.md) is shown on
// the page. The same steps and checks as "Claim as AI credits" (src/credits-web.mjs), with these differences:
//   - Who: anyone with a GitHub account (owner decision 2026-10-10). repo.ing checks the account live (its GitHub token still
//     works, for the same user) and signs in for it with an identity handoff: no repository, no admin permission
//     (src/repo-inference-handoff.mjs). The credit ledger accepts identity handoffs for packs only.
//   - The quote: the credit service prices the pack. It must be this pack, pay the pinned treasury, and ask for the fewest
//     lamports worth the pack at its own price (the credit ledger's rule): never more.
//   - The retry key is stored before the quote is asked for ('requested'), with a hash of the credit service session that
//     asks (the service keeps retry keys per session, and the session stays in the cookie even when the answer is lost).
//     A quote whose answer was lost is asked for again under the same key and session and comes back unchanged, instead
//     of a second open quote. Without that session (its cookie gone), the key is asked under a new one.
//   - The outcome carries the spin. It is checked against the pack; a credited pack without a valid spin goes to a review.
//   - A pack may be opened for a repository (src/builder-pack-shares.mjs, dark by its own switch): repo.ing checks the repository,
//     stores it with the request, and signs a ticket for it with every ask of the quote; the credit ledger freezes the builder share
//     on the quote. The quote must name the same repository and rate, or nothing is paid.
// Dark unless CREDITS_WEB_PACKS_ENABLED is exactly 'true', with the credit service settings of src/credits-web.mjs.
export const PACKS_MICRO = Object.freeze([10_000_000, 25_000_000, 50_000_000, 100_000_000])
export const MULTIPLIERS_BPS = Object.freeze([10_000, 12_000, 20_000, 50_000])
// The odds of reward policy sol-pack-v1 (repo-inference src/gacha.rs), shown until the credit service's own copy is read.
export const PACK_ODDS = Object.freeze([{ multiplier_bps: 10_000, probability_bps: 9_715 }, { multiplier_bps: 12_000, probability_bps: 250 },
  { multiplier_bps: 20_000, probability_bps: 30 }, { multiplier_bps: 50_000, probability_bps: 5 }].map(Object.freeze))
export const OPEN_PACK_STATUSES = Object.freeze(['requested', 'quoted', 'prepared', 'submitted'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const sessionHash = token => createHash('sha256').update(token).digest('hex')

export const creditsPacksSettings = (env = process.env) => env.CREDITS_WEB_PACKS_ENABLED === 'true' ? creditsServiceSettings(env) : null

export function readPack(value) {
  const pack = typeof value === 'string' && /^[1-9]\d{6,8}$/.test(value) ? Number(value) : null
  if (!PACKS_MICRO.includes(pack)) throw new CreditsWebError('A pack is $10, $25, $50 or $100.', 400)
  return pack
}

const invalid = () => new CreditsWebError('The credit service returned an invalid pack quote. Nothing was paid.', 502)
/** A pack quote from the credit service, checked against the pack asked for, the repository it backs (if any) and this deployment's settings. */
export function parsePackQuote(quote, { settings, packMicro, builder = null, now = Date.now() }) {
  const expires = Date.parse(quote?.expires_at), lamports = quote?.lamports, price = quote?.price_micro_per_sol
  if (!UUID.test(quote?.id ?? '') || quote.kind !== 'pack' || quote.pack_micro !== packMicro || quote.credit_micro !== packMicro
    || (quote.builder_repo_id ?? null) !== (builder ? String(builder.repoId) : null) || (quote.builder_share_bps ?? null) !== (builder ? builder.shareBps : null)
    || !Number.isSafeInteger(lamports) || BigInt(lamports) < MIN_LAMPORTS || BigInt(lamports) > MAX_LAMPORTS || !Number.isSafeInteger(price) || price <= 0
    || !Number.isFinite(expires) || expires <= now || expires > now + 60 * 60_000) throw invalid()
  // The fewest lamports worth the pack at the quoted price: ceil(pack x 10^9 / price), the credit ledger's own rule.
  const worth = BigInt(packMicro) * 1_000_000_000n
  if (BigInt(lamports) * BigInt(price) < worth || (BigInt(lamports) - 1n) * BigInt(price) >= worth) {
    throw new CreditsWebError('The pack quote does not match the pack at its own SOL price. Nothing was paid.', 502)
  }
  if (quote.network !== settings.network) throw new CreditsWebError(`The credit service quoted on ${String(quote.network).slice(0, 16)}, not ${settings.network}. Nothing was paid.`, 502)
  const pay = parseSolanaPay(quote.solana_pay_url)
  if (pay.recipient !== settings.treasury || pay.lamports !== BigInt(lamports) || (quote.treasury !== undefined && quote.treasury !== settings.treasury)
    || (quote.reference !== undefined && quote.reference !== pay.reference)) {
    throw new CreditsWebError('The quote does not pay the repo.ing credit treasury the quoted amount. Nothing was paid.', 502)
  }
  return { id: quote.id, lamports: String(lamports), priceMicroPerSol: String(price), expiresAt: new Date(expires).toISOString(), reference: pay.reference,
    network: quote.network }
}

/** The credit service's answer for a pack's quote → the purchase's status (and spin). Unknown answers change nothing. */
export function packOutcome(quote, packMicro) {
  if (quote?.status === 'credited') {
    const spin = quote.spin, multiplier = spin?.multiplier_bps
    if (MULTIPLIERS_BPS.includes(multiplier) && spin.paid_micro === packMicro && spin.bonus_micro === packMicro * (multiplier - 10_000) / 10_000
      && UUID.test(spin.id ?? '')) return { status: 'credited', spin: { id: spin.id, multiplierBps: multiplier, bonusMicro: spin.bonus_micro } }
    // Credited without a spin that matches the pack: a person checks it.
    return { status: 'review' }
  }
  if (quote?.review_pending === true) return { status: 'review' }
  if (quote?.status === 'expired') return { status: 'expired' }
  return null
}

// The terms the credit service states, as plain lines: at most 8, each one line of at most 400 characters.
const terms = value => (Array.isArray(value) ? value : []).filter(line => typeof line === 'string' && line.length <= 400)
  .map(line => line.replace(/[\x00-\x1f\x7f]+/g, ' ').trim()).filter(Boolean).slice(0, 8)
/** The credit service's pack offer for this account: sales, room left today, the odds (when they add up) and the terms. */
export function offerOf(value) {
  const sales = ['off', 'sandbox', 'live', 'paused'].includes(value?.sales) ? value.sales : 'off'
  const room = Number.isSafeInteger(value?.account_room_micro) && value.account_room_micro > 0 ? value.account_room_micro : 0
  const outcomes = Array.isArray(value?.policy?.outcomes) ? value.policy.outcomes : []
  const fair = outcomes.length > 0 && outcomes.every(o => MULTIPLIERS_BPS.includes(o?.multiplier_bps) && Number.isInteger(o?.probability_bps) && o.probability_bps > 0)
    && outcomes.reduce((sum, o) => sum + o.probability_bps, 0) === 10_000
  return { sales, roomMicro: room, odds: fair ? outcomes.map(o => ({ multiplier_bps: o.multiplier_bps, probability_bps: o.probability_bps })) : null, terms: terms(value?.terms) }
}

const publicPurchase = row => row && ({ id: Number(row.id), status: row.status, packMicro: String(row.pack_micro), network: row.network,
  lamports: row.lamports == null ? null : String(row.lamports), priceMicroPerSol: row.price_micro_per_sol == null ? null : String(row.price_micro_per_sol),
  expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null, payer: row.payer_wallet ?? null, signature: row.payment_signature ?? null,
  spin: row.spin_id ? { id: row.spin_id, multiplierBps: Number(row.multiplier_bps), paidMicro: String(row.pack_micro), bonusMicro: String(row.bonus_micro) } : null,
  // The page knows the repository's name from its own read of the shares route.
  builder: row.builder_repo_id ? { repoId: String(row.builder_repo_id), shareBps: row.builder_share_bps, shareMicro: String(shareMicro(row.pack_micro, row.builder_share_bps)) } : null })
const OPEN_ERROR = 'You have an open pack. Pay for it or cancel it first.'

/**
 * The pack steps for one signed-in GitHub account. githubVerifier checks the account live (app/lib/github-session.mjs,
 * currentIdentity). current is the credit service's session from the cookie, or null. builderShares is
 * builderSharesSettings() (src/builder-pack-shares.mjs): null while packs for a repository are off.
 */
export function createCreditsPacks({ pool, connection, settings, githubVerifier, builderShares = null, fetchImpl = fetch, now = () => Date.now() }) {
  const owned = async (id, githubUserId) => {
    const { rows: [row] } = await pool.query('select * from credit_pack_purchases where id=$1 and github_user_id=$2', [id, githubUserId])
    if (!row) throw new CreditsWebError('Unknown pack.', 404)
    return row
  }
  // The signed-in GitHub account, checked live (its token still works, for the same user). Only from a click.
  const buyer = async ({ login }) => {
    const identity = await githubVerifier.currentIdentity().catch(() => {
      throw new CreditsWebError('Your GitHub sign-in expired. Sign in with GitHub again.', 403)
    })
    return { login: identity.githubLogin ?? login }
  }
  // Then a new credit service session for the account: an identity handoff, with no repository.
  const signIn = async ({ githubUserId, login }) => {
    const who = await buyer({ login })
    return { ...who, session: await signInToCredits({ pool, settings, repoId: null, permission: 'identity', githubUserId, login: who.login, fetchImpl, now: now() }) }
  }
  const set = async (row, status, from, spin = null) => (await pool.query(`update credit_pack_purchases set status=$2,spin_id=$3,multiplier_bps=$4,
    bonus_micro=$5,updated_at=now() where id=$1 and status = any($6::text[]) returning *`, [row.id, status, spin?.id ?? null, spin?.multiplierBps ?? null,
    spin?.bonusMicro ?? null, from])).rows[0] ?? row
  // A failed or lost payment: its signature is kept, and the quote can be paid again while it lasts.
  const retry = async row => (await pool.query(`update credit_pack_purchases set status=$2,payment_signature=null,earlier_signatures=earlier_signatures||$3::text[],
    updated_at=now() where id=$1 and status='submitted' and payment_signature=$4 returning *`,
  [row.id, new Date(row.expires_at).getTime() > now() ? 'prepared' : 'expired', [row.payment_signature], row.payment_signature])).rows[0] ?? row
  const refresh = async (row, token) => {
    if (!['quoted', 'prepared', 'submitted'].includes(row.status)) return row
    const outcome = token ? packOutcome(await creditsCall(fetchImpl, settings.origin, `/quotes/${row.quote_id}`, { token }).catch(() => null), Number(row.pack_micro)) : null
    if (outcome && outcome.status !== 'expired') return set(row, outcome.status, ['quoted', 'prepared', 'submitted'], outcome.spin ?? null)
    if (row.status === 'submitted') {
      const chain = await chainStatus(connection, row).catch(() => 'pending')
      if (chain === 'failed' || chain === 'lost') return retry(row)
      // A payment that landed for a quote the credit service has closed: a person reviews it (a refund, or credits).
      if (chain === 'landed' && outcome?.status === 'expired') return set(row, 'review', ['submitted'])
      return row
    }
    return outcome?.status === 'expired' || new Date(row.expires_at).getTime() <= now() ? set(row, 'expired', ['quoted', 'prepared']) : row
  }
  // Asks the credit service for the pack's quote under the stored key. No answer (a 5xx, or one that cannot be read) keeps
  // the request for another try under the same key; a refusal (4xx) or a quote that fails its checks ends it.
  const fail = row => pool.query(`update credit_pack_purchases set status='failed',updated_at=now() where id=$1 and status='requested'`, [row.id])
  const ask = async (row, token) => {
    let answer, quote
    const body = { pack_micro: Number(row.pack_micro) }
    const builder = row.builder_repo_id ? { repoId: String(row.builder_repo_id), shareBps: row.builder_share_bps } : null
    // A repository's ticket is signed anew with every ask (the ledger allows 5 minutes); a retry under the same key gets the same quote.
    if (builder) {
      if (!builderShares) throw new CreditsWebError('Backing a repository is not open right now. Cancel this pack and open it again.', 400)
      body.builder = packBuilderTicket(builderShares.secret, { idempotencyKey: row.idempotency_key, githubUserId: String(row.github_user_id),
        repoId: builder.repoId, shareBps: builder.shareBps, issuedAt: new Date(now()).toISOString() })
    }
    try {
      answer = await creditsCall(fetchImpl, settings.origin, '/packs', { method: 'POST', body, token, idempotencyKey: row.idempotency_key })
    } catch (error) {
      if (error?.refused) await fail(row)
      throw error
    }
    try { quote = parsePackQuote(answer, { settings, packMicro: Number(row.pack_micro), builder, now: now() }) } catch (error) { await fail(row); throw error }
    // 'failed' too: a request made at the same time under this key (another tab) may have been refused while this one got it.
    let quoted
    try {
      quoted = (await pool.query(`update credit_pack_purchases set status='quoted',quote_id=$2,lamports=$3,price_micro_per_sol=$4,reference=$5,
        expires_at=$6,updated_at=now() where id=$1 and status in ('requested','failed') returning *`, [row.id, quote.id, quote.lamports, quote.priceMicroPerSol,
        quote.reference, quote.expiresAt])).rows[0]
    } catch (error) {
      if (error?.code === '23505') throw new CreditsWebError(OPEN_ERROR)
      throw error
    }
    if (!quoted) throw new CreditsWebError('This pack changed. Refresh and try again.')
    return quoted
  }
  return {
    /** The account's open pack, else its latest, asked again while it is open. Never signs in. */
    async status({ githubUserId, current }) {
      const { rows: [row] } = await pool.query(`select * from credit_pack_purchases where github_user_id=$1
        order by (status = any($2::text[])) desc, id desc limit 1`, [githubUserId, OPEN_PACK_STATUSES])
      if (!row) return { purchase: null, needsSignIn: false }
      const fresh = await refresh(row, current?.token)
      return { purchase: publicPurchase(fresh), needsSignIn: ['quoted', 'prepared', 'submitted'].includes(fresh.status) && !current }
    },
    /** The credit service's offer for this account (room left today), with the session in the cookie only. */
    async offer({ current }) {
      if (!current) return null
      return offerOf(await creditsCall(fetchImpl, settings.origin, '/packs', { token: current.token }).catch(() => null))
    },
    /** A click on "Refresh status": signs in again if the session is gone (a live GitHub check), then asks again. */
    async check({ id, githubUserId, login, current }) {
      const row = await owned(id, githubUserId)
      let session = null
      if (['quoted', 'prepared', 'submitted'].includes(row.status) && !current) {
        if (!await takeQuota(pool, [[`credits:check:${githubUserId}`, 10, 600]])) throw new CreditsWebError('Too many checks. Wait a few minutes.', 429)
        session = (await signIn({ githubUserId, login })).session
      }
      return { purchase: publicPurchase(await refresh(row, (current ?? session)?.token)), session }
    },
    /**
     * A quote for a pack, after a live check of the GitHub account. An open pack blocks a new one, except a request whose quote never
     * answered: it is asked for again first, under its own key and pack, with the session that asked if the cookie still
     * holds it. The session is returned (also on the error) for the cookie.
     */
    async quote({ githubUserId, login, packMicro, builderRepoId = null, current }) {
      const pack = readPack(packMicro)
      if (builderRepoId !== null && !builderShares) throw new CreditsWebError('Backing a repository is not open right now.', 400)
      if (!await takeQuota(pool, [[`credits:pack:${githubUserId}`, 6, 600], ['credits:pack', 300, 60]])) throw new CreditsWebError('Too many quotes. Wait a few minutes.', 429)
      // The repository a new pack backs, read only after the quota (a refused repository counts as a quote); a request being asked
      // for again keeps the repository stored with it.
      const target = builderRepoId === null ? null : await builderShareTarget(pool, { repoId: builderRepoId, buyerGithubUserId: githubUserId })
      const open = (await pool.query(`select * from credit_pack_purchases where github_user_id=$1 and status = any($2::text[])`, [githubUserId, OPEN_PACK_STATUSES])).rows[0]
      if (open && open.status !== 'requested' && OPEN_PACK_STATUSES.includes((await refresh(open, current?.token)).status)) throw new CreditsWebError(OPEN_ERROR)
      let row = open?.status === 'requested' ? open : null
      // Every quote checks the GitHub account live, even with a session in the cookie; only a retry keeps its session.
      const reuse = Boolean(row && current && row.session_hash === sessionHash(current.token))
      const fresh = reuse ? { ...await buyer({ login }), session: null } : await signIn({ githubUserId, login })
      const token = reuse ? current.token : fresh.session.token
      try {
        if (!row) {
          row = (await pool.query(`insert into credit_pack_purchases(github_user_id,github_login,pack_micro,idempotency_key,session_hash,network,status,
            builder_repo_id,builder_share_bps) values($1,$2,$3,$4,$5,$6,'requested',$7,$8) returning *`, [githubUserId, fresh.login, pack,
            randomBytes(16).toString('base64url'), sessionHash(token), settings.network, target ? target.repoId : null, target ? builderShares.shareBps : null])).rows[0]
        } else if (!reuse) {
          row = (await pool.query(`update credit_pack_purchases set session_hash=$2,updated_at=now() where id=$1 and status='requested' returning *`,
            [row.id, sessionHash(token)])).rows[0] ?? row
        }
        return { purchase: publicPurchase(await ask(row, token)), session: fresh.session }
      } catch (error) {
        const failure = error?.code === '23505' ? new CreditsWebError(OPEN_ERROR) : error
        if (fresh.session) failure.session = fresh.session
        throw failure
      }
    },
    /** The unsigned transfer for this pack, from `payer`. Again after a payment that failed on chain or can no longer land. */
    async prepare({ id, githubUserId, payer }) {
      if (typeof payer !== 'string' || !BASE58.test(payer)) throw new CreditsWebError('Connect a Solana wallet.', 400)
      let row = await owned(id, githubUserId)
      if (row.status === 'submitted') {
        if (['landed', 'pending'].includes(await chainStatus(connection, row))) throw new CreditsWebError('Your payment is on its way. Wait for it before approving again.')
        row = await retry(row)
      }
      if (!['quoted', 'prepared'].includes(row.status)) throw new CreditsWebError(row.status === 'expired' ? 'This quote expired. Open the pack again for a new one.' : 'This pack is closed.')
      if (new Date(row.expires_at).getTime() <= now() + 30_000) throw new CreditsWebError('This quote is about to expire. Open the pack again for a new one.')
      const wallet = new PublicKey(payer).toBase58()
      const balance = BigInt(await connection.getBalance(new PublicKey(wallet), 'confirmed'))
      if (!affordable(balance, row.lamports)) {
        throw new CreditsWebError(`Your wallet holds ${sol(balance)} SOL. This pack needs ${sol(BigInt(row.lamports) + FEE_LAMPORTS)} SOL with the network fee`
          + `${balance > BigInt(row.lamports) ? `, and a wallet that keeps SOL must keep ${sol(RENT_EXEMPT_LAMPORTS)} SOL` : ''}. Nothing was sent.`, 400)
      }
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const payment = buildPayment({ payer: wallet, treasury: settings.treasury, lamports: row.lamports, reference: row.reference, blockhash, lastValidBlockHeight })
      const { rows: [prepared] } = await pool.query(`update credit_pack_purchases set status='prepared',payer_wallet=$2,prepared_message=$3,
        last_valid_block_height=$4,updated_at=now() where id=$1 and status in ('quoted','prepared') returning *`, [row.id, wallet, payment.message, lastValidBlockHeight])
      if (!prepared) throw new CreditsWebError('This pack changed. Refresh and try again.')
      return { purchase: publicPurchase(prepared), transaction: payment.transaction }
    },
    /**
     * The wallet's signature over the prepared transfer: simulated first, then stored, then broadcast. From the broadcast
     * on, the row stays submitted; only the chain (failed, or lost after its blockhash) reopens it.
     */
    async submit({ id, githubUserId, signedTransaction }) {
      const row = await owned(id, githubUserId)
      if (row.status !== 'prepared' || !row.prepared_message) throw new CreditsWebError('This pack is not waiting for a payment.')
      if (new Date(row.expires_at).getTime() <= now() + 15_000) throw new CreditsWebError('This quote is about to expire. Nothing was sent; open the pack again for a new one.')
      const payment = assertPayment(signedTransaction, { message: row.prepared_message, payer: row.payer_wallet })
      await simulatePayment(connection, payment.raw)
      const { rows: [submitted] } = await pool.query(`update credit_pack_purchases set status='submitted',payment_signature=$2,submitted_at=now(),
        updated_at=now() where id=$1 and status='prepared' and prepared_message=$3 returning *`, [row.id, payment.signature, row.prepared_message])
      if (!submitted) throw new CreditsWebError('This pack changed. Refresh and try again.')
      await broadcast(connection, payment.raw)
      return { purchase: publicPurchase(submitted) }
    },
    /** A request, a quote, an unsigned transfer, or a payment that failed or can no longer land can be dropped; a pending one cannot. */
    async cancel({ id, githubUserId }) {
      let row = await owned(id, githubUserId)
      if (row.status === 'submitted') row = await refresh(row, null)
      const { rows: [cancelled] } = await pool.query(`update credit_pack_purchases set status='cancelled',updated_at=now()
        where id=$1 and status in ('requested','quoted','prepared') returning *`, [row.id])
      if (!cancelled) throw new CreditsWebError(row.status === 'submitted' ? 'A payment on its way cannot be cancelled. Wait for its status.' : 'This pack is closed.')
      return { purchase: publicPurchase(cancelled) }
    },
  }
}
