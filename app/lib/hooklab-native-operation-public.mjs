// Never expose signable bytes through quote/review/get. The only public wire
// response is wallet-request, after its durable issuance marker commits.
export function publicNativeOperation(operation){
 const {messageBase64,...review}=operation.review
 const fields=['id','owner','custodyOperationId','stage','profileSha256','messageSha256','status','revision','signature','signedBy','request','configurationSha256','settlement','walletRequestIssued','executionAuthorized','canSign','canSubmit']
 return {...Object.fromEntries(fields.filter(k=>Object.hasOwn(operation,k)).map(k=>[k,operation[k]])),review}
}
