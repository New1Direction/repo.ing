import { NextResponse } from 'next/server'
import { HANDOFF_REFUSED, clientAuthorized, codeHash, handoffSettings, redeemHandoff, redemptionWellFormed } from '../../../../src/repo-inference-handoff.mjs'
import { takeQuota } from '../../../../src/request-quota.mjs'
import { database } from '../../../lib/server.mjs'
export const runtime = 'nodejs'

// Server to server (src/repo-inference-handoff.mjs, step 3): the credit service redeems a code once, with the CLI's code
// verifier and its client secret, and gets the signed assertion. No cookie is read or set.
const reply = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
export async function POST(request) {
  const settings = handoffSettings(), pool = database()
  if (!settings || !pool) return reply({ error: 'Not found' }, 404)
  if (!clientAuthorized(request.headers.get('authorization'), settings)) return reply({ error: 'Unauthorized' }, 401)
  const text = await request.text()
  if (text.length > 2048) return reply({ error: 'Request too large' }, 413)
  let body
  try { body = JSON.parse(text) } catch { return reply({ error: 'Invalid JSON' }, 400) }
  const redemption = { audience: body?.audience, code: body?.code, codeVerifier: body?.code_verifier }
  if (!redemptionWellFormed(redemption)) return reply({ error: HANDOFF_REFUSED }, 410)
  // A wide limit for the whole service and a narrow one per code, so one caller cannot block every sign-in.
  if (!await takeQuota(pool, [['handoff:token', 600, 60], [`handoff:code:${codeHash(redemption.code)}`, 5, 60]])) return reply({ error: 'Too many requests' }, 429)
  const assertion = await redeemHandoff(pool, redemption, settings)
  return assertion ? reply(assertion) : reply({ error: HANDOFF_REFUSED }, 410)
}
