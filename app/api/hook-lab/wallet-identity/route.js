import { createWalletIdentityHandler } from '../../../lib/hooklab-wallet-identity.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const handler = createWalletIdentityHandler()
export const GET = handler
export const POST = handler
