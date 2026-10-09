import { QUOTE_ERRORS } from './quote-assets.mjs'
import { SYMBOL_TAKEN } from './launch-symbols.mjs'
const QUOTE_CODES=new Set(Object.values(QUOTE_ERRORS))
// A refused quote pair keeps its own code (src/quote-assets.mjs), so the client can tell it from a failed review.
export function launchFailure(error,action){
 const message=error.message||'Launch failed'
 // The fork guard (src/repo-lineage.mjs): retrying cannot change it.
 if(error.code==='COPY_OF_LAUNCHED_REPOSITORY')return {error:message,canRetry:false,code:error.code}
 // A ticker another market uses (src/launch-symbols.mjs), at review or just before sending: nothing was sent, and a new review
 // with another ticker can go ahead.
 if(error.code===SYMBOL_TAKEN)return {error:message,canRetry:true,code:SYMBOL_TAKEN}
 const uncertain=error.name==='IncompleteLaunchError'||/incomplete launch|evidence is still pending|final indexing is not ready|did not index|No wallet signature requested/i.test(message)
 // By error.name: the production build renames classes, so constructor.name is not 'DefinitiveLaunchError' there.
 const definitive=error.name==='DefinitiveLaunchError'||error.constructor?.name==='DefinitiveLaunchError'
 const canRetry=!uncertain&&(action==='prepare'||action==='quote'||definitive)
 const code=/wallet changed|altered transaction/i.test(message)?'WALLET_CHANGED':/expired|timed out/i.test(message)?'REVIEW_EXPIRED':uncertain||!canRetry?'CHECK_STATUS':'REVIEW_FAILED'
 return {error:message,canRetry,code:QUOTE_CODES.has(error.code)?error.code:code}
}
