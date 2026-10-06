import { createBundleApi } from '../../lib/bundle-api.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Bundle launches (docs/BUNDLE_LAUNCH.md): open a raise. { action: 'prepare' } builds the create transaction for the launcher's
// wallet; { action: 'submit' } co-signs and sends it once signed. Not found while Bundle launches are dark.
const api = createBundleApi()
export const POST = request => api.open(request)
