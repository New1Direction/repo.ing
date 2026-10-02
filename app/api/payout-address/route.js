import { createPayoutAddresses, PayoutAddressError } from '../../../src/payout-address.mjs'
import { createBuilderReminders, createReminderSender } from '../../../src/builder-reminders.mjs'
import { chain, database } from '../../lib/server.mjs'
import { backerLabels } from '../../lib/backers.mjs'
import { githubSessionCookie, readGithubSession, assertSameOrigin } from '../../lib/auth.mjs'
import { sessionVerifier } from '../../lib/github-session.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { publicError } from '../../lib/public-error.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Paste, or cancel, a repository's payout address (src/payout-address.mjs). Same authority as every other binding change:
// the encrypted GitHub session, an exact same-origin POST, and a fresh GitHub admin check for each repository right before
// the change. A claim-page session acts only on its own repository; a Builders session on any repository it administers.
const headers = { 'Cache-Control': 'private, no-store' }
const ACTIONS = new Set(['paste', 'paste-batch', 'cancel'])
const DENIED = /^(Open the claim page|GitHub session|Current GitHub|Recent GitHub|Repository verification mismatch|Connect GitHub)/
const SAFE = error => error instanceof PayoutAddressError || DENIED.test(error?.message ?? '') || /^(Invalid payout address action)/.test(error?.message ?? '')

// repo.ing's own wallets as the backers list labels them: team, buyback, fee wallet, launch signer, the configured
// creator and partner signers, and the tip wallet. Each is read on its own, so one unreadable key never drops the others.
const reserved = () => [...backerLabels().keys()]

// Opted-in builders hear about the change at once. Started after the request is saved and not awaited (the web service
// is a long-running Node server): email never delays, blocks or undoes the change.
function notify(request, notice) {
  const origin = publicOrigin(request.url)
  void (async () => {
    try {
      const reminders = createBuilderReminders({ pool: database(), send: createReminderSender(), secret: process.env.BUILDER_REMINDER_SECRET, origin })
      const result = await reminders.notifyPayoutAddressChange(notice)
      if (result.failed) console.error('payout address notice failed', { accepted: result.accepted, failed: result.failed })
    } catch (error) { console.error('payout address notice failed', { error: error?.name ?? 'error' }) }
  })()
}

export async function POST(request) {
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    if (!session) throw new Error('Connect GitHub again to continue.')
    const body = await request.json()
    if (!ACTIONS.has(body?.action)) throw new Error('Invalid payout address action')
    const dashboard = session.scope === 'builders'
    const repoIds = body.action === 'paste-batch' ? body.repoIds : [body.repoId]
    if (!Array.isArray(repoIds) || !repoIds.length) throw new PayoutAddressError('INVALID_REPOSITORIES', 'Choose a repository.')
    // Builders sessions may batch; a claim-page session never acts beyond its own repository.
    if (!dashboard && (body.action === 'paste-batch' || session.permission !== 'admin' || String(repoIds[0]) !== session.repoId)) {
      throw new Error('Repository verification mismatch')
    }
    const verifier = sessionVerifier(session, request.url, { dashboard })
    const verifyAuthority = input => verifier.verifyCurrentAuthority(input)
    const service = createPayoutAddresses({ pool: database(), connection: chain(), reserved: reserved() })
    if (body.action === 'cancel') {
      const result = await service.cancel({ githubRepoId: body.repoId, requestId: body.requestId, verifyAuthority })
      return Response.json({ cancelled: true, requestId: result.requestId }, { headers })
    }
    if (body.action === 'paste') {
      const result = await service.request({ githubRepoId: body.repoId, address: body.address, confirm: body.confirm, verifyAuthority })
      notify(request, { githubUserIds: result.notify, key: result.id, repoIds: [result.repoId], wallet: result.wallet,
        activeAt: result.activeAt, requestedByLogin: result.requestedByLogin, previousWallet: result.previousWallet })
      return Response.json({ pending: { id: result.id, wallet: result.wallet, requestedAt: result.requestedAt, activeAt: result.activeAt },
        previousWallet: result.previousWallet }, { headers })
    }
    const result = await service.requestBatch({ githubRepoIds: repoIds, address: body.address, confirm: body.confirm, verifyAuthority })
    notify(request, { githubUserIds: result.notify, key: `batch-${result.requests[0].id}`, repoIds: result.requests.map(r => r.repoId),
      wallet: result.wallet, activeAt: result.activeAt, requestedByLogin: result.requestedByLogin })
    return Response.json({ count: result.count, wallet: result.wallet, activeAt: result.activeAt }, { headers })
  } catch (error) {
    const status = error instanceof PayoutAddressError ? error.status : DENIED.test(error?.message ?? '') ? 403 : 400
    return Response.json({ error: publicError(error, SAFE, 'The payout address could not be saved. Refresh, check GitHub access, and try again.', 'payout address') },
      { status, headers })
  }
}
