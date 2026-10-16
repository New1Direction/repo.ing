import { productionReadiness } from '../../../../src/hooklab-production-observer.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

// No active dossier, RPC, request-selected identities or environment activation switch.
export function GET() { return json(productionReadiness()) }
export function POST() {
  console.info(JSON.stringify({ hookLabProduction: { action: 'execution', outcome: 'disabled' } }))
  return json({ code: 'PRODUCTION_EXECUTION_DISABLED', error: 'Production execution is unapproved and unavailable.' }, 423)
}
