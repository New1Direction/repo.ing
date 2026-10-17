import { createNativeReceiptReadHandler } from '../../../../lib/hooklab-native-reads.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = createNativeReceiptReadHandler()
export function POST() {
  return Response.json({ code: 'PRODUCTION_EXECUTION_DISABLED', error: 'This route only reads retained observations; execution is unavailable.' },
    { status: 423, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
}
