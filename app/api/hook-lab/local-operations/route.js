import { createHookLabDatabasePool } from '../../../../src/hooklab-database.mjs'
import { z } from 'zod'
import { localAcceptanceNetwork } from '../../../../src/hooklab-local-acceptance.mjs'
import { hookAddress } from '../../../../src/hooklab-execution-contract.mjs'
import { walletPrincipalStore } from '../../../../src/hooklab-wallet-principal.mjs'
import { readLimitedBody } from '../../../../src/token-image.mjs'
import { assertSameOrigin } from '../../../lib/auth.mjs'
import { walletIdentityConfiguration, walletIdentitySessionToken, walletIdentityQuota } from '../../../lib/hooklab-wallet-identity.mjs'
import { publicNativeOperation } from '../../../lib/hooklab-native-operation-public.mjs'
export const runtime='nodejs'
export const dynamic='force-dynamic'
const body=z.discriminatedUnion('action',[
 z.object({action:z.literal('review'),signingId:z.uuid(),request:z.object({kind:z.enum(['prepare-trading','collect-fees']),mint:hookAddress}).strict()}).strict(),
 z.object({action:z.enum(['get','wallet-request','cosign','submit','reconcile','refresh-review']),signingId:z.uuid()}).strict(),
 z.object({action:z.literal('retain-wallet'),signingId:z.uuid(),signedTransactionBase64:z.string().max(1644)}).strict(),
])
const reply=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie'}})
export async function POST(request){
 let pool
 try{
  const local=localAcceptanceNetwork();if(!local)return reply({error:'Not found'},404)
  assertSameOrigin(request,local.origin)
  if(new URL(request.url).origin!==local.origin||new URL(request.url).search||request.headers.get('sec-fetch-site')==='cross-site'||request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'Local origin and JSON required'},403)
  const token=walletIdentitySessionToken(request);if(!token)return reply({error:'Sign in with the local test wallet'},401)
  const input=body.parse(JSON.parse((await readLimitedBody(request,8192)).toString('utf8')))
  const {databaseUrl,...scope}=walletIdentityConfiguration(),service=globalThis[Symbol.for('repo.ing.hooklab.local-operations')]
  if(!service||service.origin!==local.origin)throw Error('Local runtime unavailable')
  pool=createHookLabDatabasePool({databaseUrl})
  if(!await walletIdentityQuota(pool,[[`local-operations:${local.origin}`,120]]))return reply({error:'Local request quota exceeded'},429)
  const principal=walletPrincipalStore(pool,scope),owner=await principal.resolve(token),lifecycle=service.lifecycle
  if(input.action==='wallet-request')return reply({status:'available',...await lifecycle.walletRequest(token,input.signingId)})
  let operation
  if(input.action==='review')operation=await lifecycle.createReview(token,input.signingId,{custodyOperationId:input.signingId,stage:input.request.kind==='prepare-trading'?'local-prepare-holding':'local-inclusive-collection',intent:input.request})
  else if(input.action==='get')operation=await lifecycle.get(token,input.signingId)
  else if(input.action==='refresh-review')operation=await lifecycle.refreshReview(token,input.signingId)
  else if(input.action==='retain-wallet')operation=await lifecycle.retainWalletSignature(token,input.signingId,input.signedTransactionBase64)
  else if(input.action==='cosign')operation=await lifecycle.coSignNext(token,input.signingId,service.admin)
  else if(input.action==='submit')operation=await lifecycle.submitOnce(token,input.signingId)
  else operation=await lifecycle.reconcile(token,input.signingId)
  if(operation.owner!==owner.wallet||!['local-prepare-holding','local-inclusive-collection'].includes(operation.stage))throw Error('Operation owner or stage differs')
  await principal.resolve(token)
  return reply({status:'available',operation:publicNativeOperation(operation)})
 }catch(error){return reply({error:error.status===401?'Local wallet session expired':'Local operation unavailable or changed. Preserve the signing ID and reconcile the original transaction.'},error.status===401?401:409)}
 finally{await pool?.end().catch(()=>{})}
}
