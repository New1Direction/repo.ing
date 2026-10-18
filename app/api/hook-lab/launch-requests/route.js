import { createLaunchRequestsHandler } from '../../../lib/hooklab-launch-requests.mjs'
export const dynamic='force-dynamic'
const handler=createLaunchRequestsHandler()
export const GET=handler
export const POST=handler
