import { createBundleApi } from '../../../lib/bundle-api.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// One bundle (docs/BUNDLE_LAUNCH.md): GET reads it (with ?wallet=, that wallet's shares and claimable fees); POST prepares a
// deposit, refund or claim for the wallet to sign, and relays it once signed ({ action: 'send' }). Not found while dark.
const api = createBundleApi()
export async function GET(request, { params }) { return api.read(request, (await params).id) }
export async function POST(request, { params }) { return api.act(request, (await params).id) }
