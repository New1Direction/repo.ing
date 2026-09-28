export function launchFailure(error,action){
 const message=error.message||'Launch failed'
 const uncertain=error.name==='IncompleteLaunchError'||/incomplete launch|evidence is still pending|final indexing is not ready|did not index|No wallet signature requested/i.test(message)
 const canRetry=!uncertain&&(action==='prepare'||action==='quote'||error.constructor?.name==='DefinitiveLaunchError')
 const code=/wallet changed|altered transaction/i.test(message)?'WALLET_CHANGED':/expired|timed out/i.test(message)?'REVIEW_EXPIRED':uncertain||!canRetry?'CHECK_STATUS':'REVIEW_FAILED'
 return {error:message,canRetry,code}
}
