import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
import { agreedFinalizedTransaction, agreeGraduation, evidenceJSON } from './graduation-state.mjs'

const EVENT=Buffer.from('e445a52e51cb9a1d','hex')
const SWAPS=['f8c69e91e17587c8','414b3f4ceb5b5b88']
export function dammSwapEvents(transaction,market,destination,coder) {
  if(!transaction?.meta||transaction.meta.err)throw Error('DAMM_TRADE_EVIDENCE_MISSING')
  const keys=transaction.transaction.message.accountKeys,result=[];let ordinal=0
  for(const group of transaction.meta.innerInstructions??[]){
    const active=new Map(),outer=transaction.transaction.message.instructions[group.index]
    for(const [i,ix] of [outer,...group.instructions].entries()){
      const eventIndex=ordinal++
      if(!ix)continue
      const depth=i===0?1:ix.stackHeight
      if(!Number.isInteger(depth))throw Error('DAMM_TRADE_ORDERING_MISSING')
      for(const d of active.keys())if(d>=depth)active.delete(d)
      if(!keys[ix.programIdIndex]?.equals(CP_AMM_PROGRAM_ID))continue
      const bytes=Buffer.from(bs58.decode(ix.data)),a=ix.accounts??[]
      if(SWAPS.includes(bytes.subarray(0,8).toString('hex'))){
        if(keys[a[1]]?.toBase58()===destination&&keys[a[6]]?.toBase58()===market.mint&&keys[a[7]]?.equals(NATIVE_MINT))active.set(depth,true)
        continue
      }
      if(!bytes.subarray(0,8).equals(EVENT))continue
      const decoded=coder.events.decode(bytes.subarray(8).toString('base64'))
      if(decoded?.name.toLowerCase()!=='evtswap2'||!active.has(depth-1)||decoded.data.pool.toBase58()!==destination)continue
      const d=decoded.data,direction=d.tradeDirection===1?'buy':d.tradeDirection===0?'sell':null
      if(!direction||d.collectFeeMode!==1)throw Error('DAMM_SWAP_ASSET_MISMATCH')
      const quoteAmount=(direction==='buy'?d.includedTransferFeeAmountIn:d.excludedTransferFeeAmountOut).toString()
      if(BigInt(quoteAmount)<=0n)throw Error('DAMM_SWAP_AMOUNT_INVALID')
      result.push({eventIndex,direction,quoteAmount,tradedAt:new Date(Number(d.currentTimestamp.toString())*1000),evidence:{group:group.index,instruction:ix,quoteAmount,direction}})
    }
  }
  return result
}

// Uses the existing cursor table with the DAMM address. Inserts only actual finalized swap CPIs.
export async function indexDammTrades({db,connection,verification,market,graduation}) {
  const address=graduation.pool,repoId=String(market.githubRepoId),coder=new CpAmm(connection)._program.coder
  const {rows:[cursor]}=await db.query('select last_signature from pool_fee_cursors where pool=$1',[address])
  const boundary=cursor?.last_signature??graduation.signature
  async function history(rpc){
    const result=[];let before
    for(;;){
      const page=await rpc.getSignaturesForAddress(new PublicKey(address),{limit:1000,...(before?{before}:{})},'finalized')
      for(const item of page){if(item.signature===boundary)return result;result.push({signature:item.signature,slot:item.slot,err:item.err})}
      if(page.length<1000)throw Error('DAMM_HISTORY_INCOMPLETE')
      before=page.at(-1).signature
    }
  }
  const histories=await Promise.all([connection,verification].map(history));agreeGraduation(...histories)
  for(const item of [...histories[0]].reverse()){
    if(!item.err){
      const tx=await agreedFinalizedTransaction(connection,verification,item.signature)
      for(const event of dammSwapEvents(tx,market,address,coder))await db.query(`insert into damm_trade_events
        (github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict(signature,event_index) do nothing`,[repoId,address,item.signature,event.eventIndex,tx.slot,event.tradedAt,event.quoteAmount,event.direction,evidenceJSON(event.evidence)])
    }
    await db.query(`insert into pool_fee_cursors(pool,last_signature,last_slot) values($1,$2,$3)
      on conflict(pool) do update set last_signature=excluded.last_signature,last_slot=excluded.last_slot,updated_at=now()`,[address,item.signature,item.slot])
  }
  return {complete:true,transactions:histories[0].length}
}
