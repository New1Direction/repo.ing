import { createWalletLaunchAssessmentHandler } from '../../../lib/hooklab-wallet-launch-assessment.mjs'
export const runtime='nodejs'
export const dynamic='force-dynamic'
const handler=createWalletLaunchAssessmentHandler()
export const GET=handler
export const POST=handler
