import { publicGrowth } from '../../lib/growth.mjs'
import { GROWTH_CACHE, NO_STORE } from '../../lib/cache-headers.mjs'
import { withServerTiming } from '../../lib/server-timing.mjs'
export const dynamic='force-dynamic'
export const runtime='nodejs'
export const GET=withServerTiming(async()=>{
  try{return Response.json(await publicGrowth(),{headers:GROWTH_CACHE})}
  catch{return Response.json({error:'Discovery surfaces are temporarily unavailable.'},{status:503,headers:NO_STORE})}
})
