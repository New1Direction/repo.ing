import { QUOTE_ERRORS } from './quote-assets.mjs'
const QUOTE_CODES=new Set(Object.values(QUOTE_ERRORS))
// A refused quote pair keeps its own code (src/quote-assets.mjs), so the client can tell it from a failed review.
export function launchFailure(error,action){
 const message=error.message||'Launch failed'
 const uncertain=error.name==='IncompleteLaunchError'||/incomplete launch|evidence is still pending|final indexing is not ready|did not index|No wallet signature requested/i.test(message)
 // By error.name: the production build renames classes, so constructor.name is not 'DefinitiveLaunchError' there.
 const definitive=error.name==='DefinitiveLaunchError'||error.constructor?.name==='DefinitiveLaunchError'
 const canRetry=!uncertain&&(action==='prepare'||action==='quote'||definitive)
 const code=/wallet changed|altered transaction/i.test(message)?'WALLET_CHANGED':/expired|timed out/i.test(message)?'REVIEW_EXPIRED':uncertain||!canRetry?'CHECK_STATUS':'REVIEW_FAILED'
 return {error:message,canRetry,code:QUOTE_CODES.has(error.code)?error.code:code}
}
