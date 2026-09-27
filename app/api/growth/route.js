import { database } from '../../lib/server.mjs'
import { growthSurface } from '../../../src/discoverer-growth.mjs'
export const dynamic='force-dynamic'
export const runtime='nodejs'
const headers={'Cache-Control':'no-store'}
export async function GET(){
  try{return Response.json(await growthSurface(database()),{headers})}
  catch{return Response.json({error:'Discovery surfaces are temporarily unavailable.'},{status:503,headers})}
}
