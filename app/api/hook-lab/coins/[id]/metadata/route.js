import { createCoinPublicHandler } from '../../../../../lib/hooklab-coin-public.mjs'
export const dynamic='force-dynamic'
const handler=createCoinPublicHandler()
export async function GET(request,{params}){return handler(request,{id:(await params).id,kind:'metadata'})}
