import { feeStatus, marketByRepo } from '../../../../lib/server.mjs'
export const runtime = 'nodejs'
export async function GET(request, { params }) {
  const { repo } = await params
  if (!/^\d+$/.test(repo)) return Response.json({ error: 'Invalid repository' }, { status: 400 })
  const { market } = await marketByRepo(repo)
  if (!market) return Response.json({ error: 'Market not found' }, { status: 404 })
  const fees = await feeStatus(repo)
  return Response.json({ available: fees.status === 'MATCH' ? fees.onchainCreatorFee?.toString() ?? null : null },
    { headers: { 'Cache-Control': 'no-store' } })
}
