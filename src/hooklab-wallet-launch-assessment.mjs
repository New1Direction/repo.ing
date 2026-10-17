// Read-only launch boundary: exact durable preparation identity and fresh evidence
// may be assessed, but absent signed adoption/full launch revalidation emits NO bytes.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { maxWalletPreparationRequestSchema } from './hooklab-max-wallet-preparation.mjs'
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const walletLaunchAssessmentRequestSchema=z.object({preparationId:z.uuid(),request:maxWalletPreparationRequestSchema}).strict()
export async function assessWalletLaunchPreparation({journal,sessionToken,input}) {
 const {preparationId,request}=walletLaunchAssessmentRequestSchema.parse(input)
 const retained=await journal.get(sessionToken,preparationId)
 if(retained.id!==preparationId||retained.wallet!==request.creator||retained.mint!==request.mint
   ||retained.preparationIntentSha256!==digest(request)||!isDeepStrictEqual(retained.preparedRequest,request))throw Error('Preparation identity changed')
 const fresh=await journal.reconcile(sessionToken,preparationId)
 if(fresh.id!==retained.id||fresh.wallet!==retained.wallet||fresh.mint!==retained.mint
   ||fresh.profileSha256!==retained.profileSha256||fresh.messageSha256!==retained.messageSha256
   ||fresh.preparationIntentSha256!==retained.preparationIntentSha256||!isDeepStrictEqual(fresh.preparedRequest,request))throw Error('Preparation identity changed')
 const blockers=[]
 if(fresh.status!=='candidate-preparation-matched'||fresh.evidenceConflict||!fresh.lastCollectionPrelaunchEligible)blockers.push({code:'PREPARATION_RECONCILIATION_REQUIRED',message:'Preparation is unresolved, changed, already launched or requires independent review. Preserve the original mint and signature.'})
 // There is deliberately no caller boolean, callback or environment override that can adopt release bytes.
 blockers.push({code:'OPERATOR_DEPLOYMENT_APPROVAL_REQUIRED',message:'The exact deployment profile requires operator-recorded owner approval and fresh verification against explicitly configured pins.'},
  {code:'PRODUCTION_LAUNCH_REVALIDATION_REQUIRED',message:'A production launch resolver must freshly verify launch state, governance, creator grant, signer custody, fees, lookup tables and blockhash before producing unsigned launch bytes.'})
 return Object.freeze({schema:'repoing/wallet-launch-assessment/1',status:'blocked',preparation:fresh,blockers,
  unsignedLaunchMessage:null,preparationReceiptAccepted:false,deploymentAdopted:false,executionAuthorized:false,canSign:false,canSubmit:false,canLaunch:false})
}
