import { bundleLaunchable } from '../../src/bundle-launch.mjs'
import { STATUS, bundleAddress, pendingBackerFees } from '../../src/bundle-vault.mjs'
import { BUNDLE_ACTIONS, BundleRaiseError, RAISE_REFUSALS, acceptSignedAction, acceptSignedCreate, actionInstructions, bundleMatchesRow,
  createInstructionFor, depositRefusal, lamportsOf, raiseTerms, tokenFields, walletKey } from '../../src/bundle-raise.mjs'
import { hasWrappedSolAccount, readBacker, readBundle, sendSigned, walletTransaction } from '../../src/bundle-raise-chain.mjs'
import { insertOpeningBundle, loadBundle, markRaising, nextBundleId, repositoryBlockers } from '../../src/bundle-raise-store.mjs'
import { resolvePublicRepositoryById } from '../../src/github.mjs'
import { RepositoryResolutionError } from '../../src/github-url.mjs'
import { isGithubRepoId } from '../../src/market-identity.mjs'
import { DecisionError, assertLaunchAllowed } from '../../src/maintainer-opt-outs.mjs'
import { LineageError, checkLaunchLineage } from '../../src/repo-lineage.mjs'
import { persistLaunchRepository } from '../../src/repository-store.mjs'
import { readLimitedBody, validateTokenImage } from '../../src/token-image.mjs'
import { publicError } from './public-error.mjs'
import { refuseOverLimit } from './request-limits.mjs'
import { readBundleState } from './bundle-state.mjs'
import { chain, creatorSigner, database } from './server.mjs'

// The raise flow's API (docs/BUNDLE_LAUNCH.md): POST /api/bundles opens a raise (prepare, then submit the wallet-signed
// transaction), GET /api/bundles/[id] reads one, POST /api/bundles/[id] prepares a deposit, refund or claim for a wallet to sign
// and relays it once signed (send). Dark: only what starts or funds a raise (opening one, a deposit, relaying a deposit) answers
// 404 unless bundleLaunchable(). Bundles that already exist are read, refunded and claimed whatever the switch says, so a backer
// is never locked out. The dependencies are injectable so tests run without services; the routes use the defaults.

const headers = { 'Cache-Control': 'private, no-store' }
const reply = (body, status = 200) => Response.json(body, { status, headers })
export const notFound = () => reply({ error: 'Not found' }, 404)
// A prepared opening is co-signed and sent only this long after it was prepared (as a launch review, src/launch-sessions.mjs):
// its blockhash lasts about a minute, and an 'opening' row older than this can no longer become a raise through this route.
export const OPENING_SUBMIT_MS = 120_000
const MAX_OPEN_BODY = 600_000
const MAX_ACTION_BODY = 16_000
const IMAGE_MESSAGE = /^(Token image|Invalid token image|Choose a token image|Image is)/
const unconfigured = () => new BundleRaiseError('Bundle launches are not configured.', 503)

// Only this flow's own refusals, the repository checks' and the token image's reach the page (app/lib/public-error.mjs).
function failure(error) {
  const safe = error instanceof BundleRaiseError || error instanceof RepositoryResolutionError || error instanceof DecisionError ||
    error instanceof LineageError || IMAGE_MESSAGE.test(error?.message ?? '')
  const status = safe ? (Number.isInteger(error.status) ? error.status : 400) : 503
  return reply({ error: publicError(error, () => safe, 'Bundles are temporarily unavailable. Try again shortly.', 'bundle request'),
    ...safe && typeof error.code === 'string' ? { code: error.code } : {} }, status)
}

const bundleIdOf = value => /^[1-9]\d{0,18}$/.test(String(value ?? '')) ? BigInt(value) : null
async function jsonBody(request, limit) {
  try { return JSON.parse((await readLimitedBody(request, limit)).toString('utf8')) }
  catch { throw new BundleRaiseError('Invalid request') }
}

export function createBundleApi({ launchable = () => bundleLaunchable(), pool = database, connection = chain, admin = creatorSigner,
  resolveRepository = resolvePublicRepositoryById, launchAllowed = assertLaunchAllowed, persistRepository = persistLaunchRepository,
  lineage = checkLaunchLineage, validateImage = validateTokenImage, limit = refuseOverLimit, now = Date.now, broadcast = {} } = {}) {
  const services = () => {
    const db = pool(), signer = admin()
    if (!db || !signer) throw unconfigured()
    return { db, signer, rpc: connection() }
  }

  // Repository checks exactly as a standard launch review makes them (app/api/launch/route.js): a public GitHub repository read
  // by its id, the maintainer's opt-out, the fork guard; then no market (or launch in progress) and no live bundle.
  async function prepareOpen(request, body) {
    const refused = limit(request, 'launch:prepare', { canRetry: true })
    if (refused) return refused
    const { db, signer, rpc } = services()
    const repoId = String(body.repoId ?? '')
    if (!isGithubRepoId(repoId)) throw new BundleRaiseError(RAISE_REFUSALS.repository)
    const terms = raiseTerms(body, now()), token = tokenFields(body), creator = walletKey(body.launcherWallet)
    if (creator.equals(signer.publicKey)) throw new BundleRaiseError(RAISE_REFUSALS.creator)
    const tokenImage = await validateImage(body.tokenImage)
    const repo = await resolveRepository(repoId)
    await launchAllowed(db, repoId)
    await persistRepository(db, repo)
    await lineage({ pool: db, repo })
    const blockers = await repositoryBlockers(db, repoId)
    if (blockers.hasMarket) throw new BundleRaiseError(RAISE_REFUSALS.market, 409)
    if (blockers.liveBundle) throw new BundleRaiseError(RAISE_REFUSALS[blockers.liveBundle === 'opening' ? 'opening' : 'live'], 409)
    const bundleId = await nextBundleId(db)
    const row = { bundleId, githubRepoId: repoId, creatorWallet: creator.toBase58(), targetLamports: terms.targetLamports,
      minDepositLamports: terms.minDepositLamports, deadline: new Date(terms.deadline * 1000) }
    // Simulated before the row exists: a raise Solana would refuse is never recorded or offered for signing.
    const prepared = await walletTransaction(rpc, [createInstructionFor(row, signer.publicKey)], { feePayer: creator,
      fallback: 'Solana refused to open this bundle. Try again shortly.' })
    const address = bundleAddress(bundleId).toBase58()
    if (!await insertOpeningBundle(db, { ...row, address, ...token, tokenImage, deadline: terms.deadline })) throw new BundleRaiseError(RAISE_REFUSALS.live, 409)
    return reply({ bundleId: bundleId.toString(), address, ...prepared })
  }

  // The wallet signed the opening: checked against the row, co-signed by repo.ing's admin, sent, confirmed, read back from the
  // chain, and only then is the row 'raising'. Repeating it after a timeout finds the account on chain and answers the same.
  async function submitOpen(body) {
    const { db, signer, rpc } = services()
    const bundleId = bundleIdOf(body.bundleId)
    const row = bundleId === null ? null : await loadBundle(db, bundleId)
    if (!row || ['expired', 'failed'].includes(row.status)) throw new BundleRaiseError(RAISE_REFUSALS.expired)
    if (row.status !== 'opening') return reply({ bundleId: row.bundleId, signature: row.createSignature, status: row.status })
    const signed = acceptSignedCreate(row, signer, body.transaction)
    const landed = await readBundle(rpc, bundleId)
    if (landed) {
      // An earlier attempt landed and its answer was lost: its signature is recorded when this is that transaction.
      const status = await rpc.getSignatureStatuses([signed.signature]).then(result => result.value?.[0] ?? null, () => null)
      return opened(db, row, landed, status && !status.err ? signed.signature : null)
    }
    if (Number(row.ageMs) > OPENING_SUBMIT_MS) throw new BundleRaiseError(RAISE_REFUSALS.expired)
    const sent = await sendSigned(rpc, { raw: signed.raw, signature: signed.signature, lastValidBlockHeight: Number(body.lastValidBlockHeight) }, broadcast)
    if (!sent.confirmed) return reply({ bundleId: row.bundleId, signature: sent.signature, status: 'opening', pending: true }, 202)
    const bundle = await readBundle(rpc, bundleId)
    if (!bundle) return reply({ bundleId: row.bundleId, signature: sent.signature, status: 'opening', pending: true }, 202)
    return opened(db, row, bundle, sent.signature)
  }

  async function opened(db, row, bundle, signature) {
    if (!bundleMatchesRow(bundle, row)) throw new BundleRaiseError('This bundle on Solana does not match the one prepared. Contact repo.ing.', 409)
    await markRaising(db, row.bundleId, signature)
    return reply({ bundleId: row.bundleId, signature, status: 'raising' })
  }

  // What each action needs from the chain before its transaction is built; a refusal names the reason.
  async function actionOptions(action, { rpc, id, bundle, wallet, body }) {
    if (action === 'deposit') {
      const lamports = lamportsOf(body.lamports), refusal = depositRefusal(bundle, lamports, Math.floor(now() / 1000))
      if (refusal) throw new BundleRaiseError(refusal)
      return { lamports }
    }
    if (action === 'refund' && bundle.status !== STATUS.FAILED) throw new BundleRaiseError('Refunds open only after a raise fails.')
    const backer = await readBacker(rpc, id, wallet)
    if (!backer) throw new BundleRaiseError('This wallet has no deposit in this bundle.')
    if (action === 'refund') return {}
    if (pendingBackerFees(bundle, backer) <= 0n) throw new BundleRaiseError('There is nothing to claim yet.')
    return { keepWrapped: await hasWrappedSolAccount(rpc, wallet) }
  }

  return {
    // POST /api/bundles: starts a raise, so only while Bundle launches are on.
    async open(request) {
      if (!launchable()) return notFound()
      try {
        const body = await jsonBody(request, MAX_OPEN_BODY)
        if (body?.action === 'prepare') return await prepareOpen(request, body)
        if (body?.action === 'submit') return await submitOpen(body)
        throw new BundleRaiseError('Unsupported bundle action')
      } catch (error) { return failure(error) }
    },

    // GET /api/bundles/[id]?wallet=: whatever the switch says.
    async read(request, id) {
      try {
        const bundleId = bundleIdOf(id)
        if (bundleId === null) return notFound()
        const refused = limit(request, 'bundle:read')
        if (refused) return refused
        const db = pool()
        if (!db) throw unconfigured()
        const wallet = new URL(request.url).searchParams.get('wallet')
        const state = await readBundleState({ pool: db, connection: connection(), id: bundleId, wallet: wallet ? walletKey(wallet) : null })
        return state ? reply(state) : notFound()
      } catch (error) { return failure(error) }
    },

    // POST /api/bundles/[id]: deposit | refund | claim → an unsigned transaction; send → the signed one relayed. A deposit (and its
    // relay) funds a raise, so only while Bundle launches are on; a refund or a claim whatever the switch says.
    async act(request, id) {
      try {
        const bundleId = bundleIdOf(id)
        if (bundleId === null) return notFound()
        const body = await jsonBody(request, MAX_ACTION_BODY)
        if (body?.action !== 'send' && !BUNDLE_ACTIONS.includes(body?.action)) throw new BundleRaiseError('Unsupported bundle action')
        if (body.action === 'deposit' && !launchable()) return notFound()
        // A signed transaction is never limited (as a trade's submit); preparing one simulates it and reads fees.
        const refused = body.action === 'send' ? null : limit(request, 'bundle:prepare')
        if (refused) return refused
        const db = pool()
        if (!db) throw unconfigured()
        if (!await loadBundle(db, bundleId)) return notFound()
        const rpc = connection()
        if (body.action === 'send') {
          const accepted = acceptSignedAction({ id: bundleId, wallet: body.wallet, transactionBase64: body.transaction })
          if (accepted.action === 'deposit' && !launchable()) return notFound()
          const sent = await sendSigned(rpc, { raw: accepted.raw, signature: accepted.signature, lastValidBlockHeight: Number(body.lastValidBlockHeight) },
            broadcast)
          return reply({ action: accepted.action, ...sent }, sent.confirmed ? 200 : 202)
        }
        const wallet = walletKey(body.wallet), bundle = await readBundle(rpc, bundleId)
        if (!bundle) throw new BundleRaiseError('This bundle is not open on Solana yet.')
        const options = await actionOptions(body.action, { rpc, id: bundleId, bundle, wallet, body })
        const prepared = await walletTransaction(rpc, actionInstructions(body.action, { wallet, id: bundleId, ...options }), { feePayer: wallet })
        return reply({ action: body.action, ...prepared })
      } catch (error) { return failure(error) }
    },
  }
}
