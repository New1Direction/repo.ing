export function newMintReviewInput({operationId,wallet,capBps,label}){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)||typeof wallet!=='string'||!wallet)throw Error('Connect your wallet and provide the retained operation ID.')
 if(typeof capBps!=='string'||!/^\d{1,4}$/.test(capBps)||Number(capBps)<1||Number(capBps)>9999)throw Error('Choose a cap from 1 to 9999 basis points.')
 if(typeof label!=='string'||!label||new TextEncoder().encode(label).length>32)throw Error('Use a label of 1 to 32 UTF-8 bytes.')
 return {operationId,wallet,capBps:Number(capBps),label}
}
export function newMintReviewProjection(result,{operationId,wallet}){
 if(!result||!['blocked','candidate-review-only'].includes(result.status)||result.operationId!==operationId||result.wallet!==wallet
  ||result.productionUnsignedMessage!==null||result.canSign!==false||result.canSubmit!==false||result.executionAuthorized!==false)throw Error('Preparation response changed. Preserve your operation ID.')
 return result
}
