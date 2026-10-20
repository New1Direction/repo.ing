// Never expose signable bytes through quote/review/get. The only public wire
// response is wallet-request, after its durable issuance marker commits.
export function publicNativeOperation(operation){
 const {messageBase64,...review}=operation.review
 const fields=['id','owner','custodyOperationId','stage','profileSha256','messageSha256','status','revision','signature','signedBy','request','configurationSha256','settlement','walletRequestIssued','executionAuthorized','canSign','canSubmit']
 return {...Object.fromEntries(fields.filter(k=>Object.hasOwn(operation,k)).map(k=>[k,operation[k]])),review}
}
// A trade's review as the browser gets it: without the transaction's account list and lookup tables, so a stack's internal
// accounts (our stack's quote marker among them) never reach the browser as data. The wallet still shows the transaction.
export function customerTradeReview(review){
 if(!review)return review
 const {accounts,lookupTables,...rest}=review
 return rest
}
