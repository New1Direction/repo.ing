import { recoverFreshHltest } from '../../../../src/hooklab-fresh-plain.mjs'
import acceptance from '../../../../src/hooklab-hltest-acceptance.json' with { type: 'json' }
import { directCoinConnection } from '../../../../src/direct-coin-adapters.mjs'
import { refuseOverLimit } from '../../../lib/request-limits.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

// Fixed, already-finalized acceptance only. No user-selected RPC, message, mint or signature.
export async function GET(request) {
  const query = new URL(request.url).searchParams
  if (query.size !== 1 || query.get('confirmedNetwork') !== 'devnet') {
    return json({ error: 'Explicit devnet confirmation is required. Only the retained HLTEST acceptance can be recovered.' }, 400)
  }
  const limited = refuseOverLimit(request, 'direct-coins:inspect')
  if (limited) return limited
  const started = Date.now()
  let outcome = 'unavailable'
  try {
    const recovery = await recoverFreshHltest(directCoinConnection(), acceptance.preview, acceptance.signature, { confirmedNetwork: 'devnet' })
    outcome = recovery.status
    return json({ recovery })
  } catch {
    return json({ error: 'Finalized recovery unavailable or state differs from acceptance. Preserve the same mint and signature; do not relaunch.' }, 503)
  } finally {
    console.info(JSON.stringify({ hookLab: { action: 'recover-hltest', outcome, durationMs: Date.now() - started } }))
  }
}
