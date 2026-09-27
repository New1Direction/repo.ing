import { createWalletBinding } from '../../../../src/wallet-binding.mjs'
import { database } from '../../../lib/server.mjs'
import { githubSessionCookie, readGithubSession, assertSameOrigin } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { mapLimited } from '../../../../src/builder-queue.mjs'
export const runtime = 'nodejs'

export async function POST(request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    if (!session) throw new Error('Connect GitHub again to continue.')
    const body = await request.json(), pool = database()
    let ids
    if (body.action === 'challenge') {
      ids = body.repoIds
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !/^[1-9]\d*$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Choose up to 100 distinct repositories.')
    } else if (body.action === 'bind') {
      if (!Array.isArray(body.nonces) || !body.nonces.length || body.nonces.length > 100 || body.nonces.some(n => !/^[0-9a-f]{48}$/.test(n))) throw new Error('Invalid wallet review.')
      const { rows } = await pool.query(`select github_repo_id::text as id from wallet_binding_challenges
        where nonce=any($1::text[]) and github_user_id=$2 and wallet=$3 and consumed_at is null and expires_at>now()`, [body.nonces,session.githubUserId,body.wallet])
      if (rows.length !== body.nonces.length) throw new Error('Wallet review expired or already used. Refresh and try again.')
      ids = rows.map(row => row.id)
    } else throw new Error('Invalid action.')
    const verifier = sessionVerifier(session, request.url, { dashboard: true })
    await mapLimited(ids, 3, githubRepoId => verifier.verifyCurrentAuthority({ githubRepoId }))
    const binder = createWalletBinding({ pool })
    const result = body.action === 'challenge' ? await binder.requestBatchChallenge({ githubRepoIds: ids, githubUserId: session.githubUserId, wallet: body.wallet }) :
      await binder.bindBatch({ nonces:body.nonces,githubUserId:session.githubUserId,wallet:body.wallet,signature:Buffer.from(body.signature,'base64') })
    return Response.json(result, { headers })
  } catch { return Response.json({ error: 'Wallet setup could not finish. Check GitHub access, refresh, and try again. No existing payout wallets were changed.' }, { status: 400, headers }) }
}
