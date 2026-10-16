import { z } from 'zod'
import { githubSessionCookie, readGithubSession } from '../../../../lib/auth.mjs'
import { productionAccountDatabase, productionAccountEnabled, productionReadConfiguration } from '../../../../lib/hooklab-production.mjs'
import { productionReadiness, inspectProductionEvidence } from '../../../../../src/hooklab-production-observer.mjs'
import { readProductionEvidence } from '../../../../../src/hooklab-production-rpc.mjs'
import { plainRecoveryJournal } from '../../../../../src/hooklab-plain-journal.mjs'
import { takeQuota } from '../../../../../src/request-quota.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const json = (body, status = 200) => Response.json(body, { status,
  headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
const summary = row => row ? { id: row.id, mint: row.mint, messageSha256: row.message_sha256,
  signature: row.signature, status: row.status, receiptRetained: row.receipt_retained ?? Boolean(row.retained_receipt),
  createdAt: row.created_at, checkedAt: row.checked_at, chainVerified: false, canSign: false, canSubmit: false, canRetry: false } : null

export async function GET(request) {
  const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  if (!session) return json({ signedIn: false, error: 'Sign in with GitHub to read your retained operations.' }, 401)
  const query = new URL(request.url).searchParams
  const id = query.get('id')
  if ([...query.keys()].some(k => k !== 'id') || query.getAll('id').length > 1 || (id !== null && !z.uuid().safeParse(id).success)) {
    return json({ error: 'Invalid recovery request.' }, 400)
  }
  const base = { signedIn: true, githubLogin: session.githubLogin, readiness: productionReadiness(),
    accountEnabled: productionAccountEnabled(), entries: [], entry: null, canSign: false, canSubmit: false }
  if (!base.accountEnabled) return json({ ...base, status: 'disabled', error: 'Account recovery reads await approved schema and service rollout.' })
  try {
    const pool = productionAccountDatabase()
    if (!pool) throw Error()
    if (!await takeQuota(pool, [[`hooklab-production-read:${session.githubUserId}`, 120, 3600]])) {
      return json({ error: 'Too many recovery reads. Try again later.' }, 429)
    }
    const journal = plainRecoveryJournal(pool)
    const entry = id ? await journal.get(session.githubUserId, id) : null
    if (id && !entry) return json({ error: 'Retained operation not found.' }, 404)
    const entries = (await journal.list(session.githubUserId)).map(summary)
    let evidence = inspectProductionEvidence()
    try {
      const configuration = await productionReadConfiguration()
      if (configuration) evidence = await readProductionEvidence(configuration)
    } catch { /* Existing journals remain readable during configuration/provider outages. */ }
    return json({ ...base, status: 'read-only', entries, entry: summary(entry), limit: 50,
      evidence: { status: evidence.status, reason: evidence.reason, observedSlots: evidence.observedSlots,
        accountBindingsMatched: evidence.accountBindingsMatched, policyVerified: false, provenanceVerified: false } })
  } catch {
    return json({ ...base, status: 'unavailable', error: 'Recovery storage unavailable. Preserve the original message, mint and signature; do not retry a launch.' }, 503)
  }
}

// The account route cannot become a back door around the existing unconditional execution gate.
// Wallet proof methods remain private until a trusted production preparation service is approved.
export function POST() { return json({ code: 'PRODUCTION_EXECUTION_DISABLED', error: 'Production preparation and execution remain unapproved.' }, 423) }
