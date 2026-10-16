import { hardenedReadiness, refuseHardenedExecution } from '../../../../src/hooklab-hardened.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export function GET() {
  try { return json(hardenedReadiness()) }
  catch { return json({ error: 'Candidate assets unavailable. All execution remains disabled.' }, 503) }
}

// Do not read payloads or call wallets, RPC, storage or private-key services. No activation API.
export function POST() {
  try { refuseHardenedExecution() }
  catch (error) {
    console.info(JSON.stringify({ hookLabHardened: { action: 'execution', outcome: 'disabled' } }))
    return json({ error: error.message, code: error.code }, error.status)
  }
}
