import { createCoinPublicHandler } from '../../lib/hooklab-coin-public.mjs'
export const dynamic='force-dynamic'
const handler=createCoinPublicHandler()
export async function GET(request,{params}){return handler(request,{alias:(await params).alias,kind:'metadata'})}
