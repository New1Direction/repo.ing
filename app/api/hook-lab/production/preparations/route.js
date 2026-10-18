import { createCustomPreparationReadHandler } from '../../../../lib/hooklab-custom-preparation-reads.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = createCustomPreparationReadHandler()
// No request-body consumption, signer, verifier trigger, scheduler or write route.
export function POST() {
  return Response.json({ code: 'PRODUCTION_EXECUTION_DISABLED', canSign: false, canSubmit: false,
    error: 'Preparation mutation and execution remain unavailable.' },
  { status: 423, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
}
