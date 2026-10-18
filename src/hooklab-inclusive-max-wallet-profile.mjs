// Explicit candidate family. No deployment acceptance and no implicit fee choice.
import {z} from 'zod'
import {maxWalletProfileSchema,maxWalletPreparationRequestSchema} from './hooklab-max-wallet-preparation.mjs'
import { LOCAL_PROFILE_SCHEMA, localAcceptanceNetwork } from './hooklab-local-acceptance.mjs'
export const inclusiveMaxWalletProfileSchema=maxWalletProfileSchema.extend({
 schema:z.literal('hook-lab/offline-inclusive-max-wallet-builder-profile/1'),
 buildFeature:z.literal('inclusive-fees-candidate'),
 capability:maxWalletProfileSchema.shape.capability.extend({creatorFeeBps:z.number().int().min(0).max(9999),policyVersion:z.literal(2),feeModel:z.literal(2),protocolShareBps:z.literal(2500),eligibleFeeClass:z.literal('creator-quote'),rounding:z.literal('floor-platform-per-swap-residual-creator')}).strict(),
}).strict()
export const inclusiveMaxWalletPreparationRequestSchema=maxWalletPreparationRequestSchema.extend({
 schema:z.literal('repoing/inclusive-max-wallet-preparation-request/1'),policyVersion:z.literal(2),creatorFeeBps:z.number().int().min(0).max(9999),feeModel:z.literal(2),protocolShareBps:z.literal(2500),
}).strict()
export const isInclusiveMaxWalletProfile=profile=>['hook-lab/offline-inclusive-max-wallet-builder-profile/1',LOCAL_PROFILE_SCHEMA].includes(profile?.schema)
export function parseInclusiveMaxWalletProfile(profile){
 if(profile?.schema!==LOCAL_PROFILE_SCHEMA)return inclusiveMaxWalletProfileSchema.parse(profile)
 const local=localAcceptanceNetwork()
 if(!local)throw Error('Local profile requires explicit isolated acceptance configuration')
 return inclusiveMaxWalletProfileSchema.extend({schema:z.literal(LOCAL_PROFILE_SCHEMA),genesisHash:z.literal(local.genesisHash)}).strict().parse(profile)
}
export const parseMaxWalletProfile=profile=>isInclusiveMaxWalletProfile(profile)?parseInclusiveMaxWalletProfile(profile):maxWalletProfileSchema.parse(profile)
export const parseMaxWalletPreparationRequest=request=>(request?.policyVersion===2?inclusiveMaxWalletPreparationRequestSchema:maxWalletPreparationRequestSchema).parse(request)
