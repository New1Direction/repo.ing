import bs58 from 'bs58'
import { PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, getAccount, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm, CP_AMM_PROGRAM_ID, derivePositionAddress, derivePositionNftAccount, deriveTokenVaultAddress } from '@meteora-ag/cp-amm-sdk'
const EVENT = Buffer.from('e445a52e51cb9a1d','hex')

export async function verifyLiquidityReceipt(connection,intent) {
  const receipt=await connection.getTransaction(intent.signature,{commitment:'finalized',maxSupportedTransactionVersion:0})
  if(!receipt)return null
  const signed=Transaction.from(Buffer.from(intent.signed_transaction,'base64'))
  if(!receipt.meta||receipt.transaction.signatures[0]!==intent.signature||!signed.compileMessage().serialize().equals(receipt.transaction.message.serialize()))throw Error('Liquidity receipt differs from durable signed intent')
  if(receipt.meta.err){
    return {id:intent.id,status:'aborted',signature:intent.signature}
  }
  const owner=new PublicKey(intent.lp_owner),pool=new PublicKey(intent.pool),mint=new PublicKey(intent.token_a_mint),nftMint=new PublicKey(intent.position_nft_mint)
  if(intent.source_wallet!==intent.lp_owner||intent.token_b_mint!==NATIVE_MINT.toBase58()||!signed.feePayer.equals(owner))throw Error('Liquidity authority or assets differ')
  const position=derivePositionAddress(nftMint),keys=receipt.transaction.message.accountKeys,amm=new CpAmm(connection)
  const events=[]
  for(const group of receipt.meta.innerInstructions??[])for(const ix of group.instructions){
    if(!keys[ix.programIdIndex]?.equals(CP_AMM_PROGRAM_ID))continue
    const data=Buffer.from(bs58.decode(ix.data))
    if(data.subarray(0,8).equals(EVENT)){const event=amm._program.coder.events.decode(data.subarray(8).toString('base64'));if(event)events.push(event)}
  }
  const swaps=events.filter(e=>e.name.toLowerCase()==='evtswap2'),deposits=events.filter(e=>e.name.toLowerCase()==='evtliquiditychange')
  if(swaps.length!==1||deposits.length!==1)throw Error('Expected exactly one swap and one deposit receipt')
  const swap=swaps[0].data,deposit=deposits[0].data
  const input=BigInt(swap.includedTransferFeeAmountIn.toString()),output=BigInt(swap.excludedTransferFeeAmountOut.toString())
  const a=BigInt(deposit.tokenAAmount.toString()),b=BigInt(deposit.tokenBAmount.toString()),liquidity=BigInt(deposit.liquidityDelta.toString())
  if(!swap.pool.equals(pool)||!deposit.pool.equals(pool)||!deposit.position.equals(position)||!deposit.owner.equals(owner)||
    input!==BigInt(intent.swap_amount)||output<BigInt(intent.min_swap_output)||a<=0n||b<=0n||a>output||
    a>BigInt(intent.max_amount_token_a)||b>BigInt(intent.max_amount_token_b)||liquidity!==BigInt(intent.expected_liquidity)||liquidity<BigInt(intent.minimum_liquidity))throw Error('Liquidity settlement differs from the reviewed amounts')
  const delta=(address,tokenMint)=>{
    const index=keys.findIndex(k=>k.equals(address))
    if(index<0)throw Error('Required token account missing from receipt')
    const pre=receipt.meta.preTokenBalances?.find(x=>x.accountIndex===index&&x.mint===tokenMint.toBase58())
    const post=receipt.meta.postTokenBalances?.find(x=>x.accountIndex===index&&x.mint===tokenMint.toBase58())
    return BigInt(post?.uiTokenAmount.amount??0)-BigInt(pre?.uiTokenAmount.amount??0)
  }
  if(delta(getAssociatedTokenAddressSync(mint,owner),mint)!==output-a||
    delta(deriveTokenVaultAddress(mint,pool),mint)!==a-output||delta(deriveTokenVaultAddress(NATIVE_MINT,pool),NATIVE_MINT)!==input+b)throw Error('Pool and wallet token deltas do not match the receipts')
  const positionInfo=await connection.getAccountInfo(position,'finalized')
  if(!positionInfo?.owner.equals(CP_AMM_PROGRAM_ID))throw Error('Missing canonical liquidity position')
  const state=amm._program.coder.accounts.decode('position',positionInfo.data)
  const nft=await getAccount(connection,derivePositionNftAccount(nftMint),'finalized',TOKEN_2022_PROGRAM_ID)
  if(!state.pool.equals(pool)||!state.nftMint.equals(nftMint)||!nft.owner.equals(owner)||!nft.mint.equals(nftMint)||nft.amount!==1n||nft.delegate||
    BigInt(state.unlockedLiquidity.add(state.permanentLockedLiquidity).add(state.vestedLiquidity).toString())!==liquidity)throw Error('Liquidity position or protected ownership differs from receipt')
  const nativeDelta=address=>{
    const index=keys.findIndex(k=>k.equals(address));if(index<0)return 0n
    return BigInt(receipt.meta.preBalances[index])-BigInt(receipt.meta.postBalances[index])
  }
  const economicDebit=input+b
  const networkCost=nativeDelta(owner)+nativeDelta(getAssociatedTokenAddressSync(NATIVE_MINT,owner))-economicDebit
  if(economicDebit>BigInt(intent.source_amount)||networkCost<0n||networkCost>BigInt(intent.max_network_cost))throw Error('Settled debit exceeds the reviewed budget')
  return {id:intent.id,status:'settled',signature:intent.signature,position:position.toBase58(),slot:receipt.slot,
    liquidity:String(liquidity),economicDebit:String(economicDebit),tokenA:String(a),tokenB:String(b),networkCost:String(networkCost),
    networkFee:String(receipt.meta.fee),walletDebit:String(economicDebit+networkCost),lpOwner:intent.lp_owner}
}

export async function settleLiquidityIntent(db,connection,intent) {
  const proof=await verifyLiquidityReceipt(connection,intent)
  if(!proof)return null
  if(proof.status==='aborted'){
    await db.query("update liquidity_intents set status='aborted',resolved_at=now(),resolution_reason='Finalized transaction failed' where id=$1 and status='submitted'",[intent.id])
    return proof
  }
  const {rows:[updated]}=await db.query(`update liquidity_intents set status='settled',settled_at=now(),position=$2,
    settled_liquidity=$3,settled_debit=$4,settled_token_a=$5,settled_token_b=$6,settled_network_cost=$7 where id=$1 and status='submitted' returning id,status,signature`,
    [intent.id,proof.position,proof.liquidity,proof.economicDebit,proof.tokenA,proof.tokenB,proof.networkCost])
  return updated??(intent.status==='settled'?{id:intent.id,status:'settled',signature:intent.signature}:null)
}

export function createLiquidityRecovery({pool,connection}) {
  return {async runOnce(){
    const {rows}=await pool.query("select id from liquidity_intents where status='submitted' order by id")
    const results=[]
    for(const row of rows){
      const db=await pool.connect()
      try{
        if(!(await db.query("select pg_try_advisory_lock(hashtextextended('liquidity-reserve',0)) as locked")).rows[0].locked)continue
        try{
          const {rows:[intent]}=await db.query("select * from liquidity_intents where id=$1 and status='submitted'",[row.id])
          if(!intent)continue
          let settled=await settleLiquidityIntent(db,connection,intent)
          if(!settled){
            const status=(await connection.getSignatureStatuses([intent.signature],{searchTransactionHistory:true})).value[0]
            if(!status&&BigInt(await connection.getBlockHeight('finalized'))>BigInt(intent.last_valid_block_height)){
              settled=await settleLiquidityIntent(db,connection,intent)
              if(!settled&&!(await connection.getSignatureStatuses([intent.signature],{searchTransactionHistory:true})).value[0]){
                await db.query("update liquidity_intents set status='aborted',resolved_at=now(),resolution_reason='Expired without chain evidence' where id=$1 and status='submitted'",[intent.id])
                settled={status:'aborted'}
              }
            }else if(!status)await connection.sendRawTransaction(Buffer.from(intent.signed_transaction,'base64'),{skipPreflight:false})
          }
          results.push({id:intent.id,repoId:String(intent.github_repo_id),status:settled?.status??'submitted'})
        }finally{await db.query("select pg_advisory_unlock(hashtextextended('liquidity-reserve',0))")}
      }catch{results.push({id:row.id,status:'review'})}finally{db.release()}
    }
    return results
  }}
}
