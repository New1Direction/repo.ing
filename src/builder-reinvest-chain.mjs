import { createHash } from 'node:crypto'
import BN from 'bn.js'
import { Keypair, PublicKey, Transaction, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm, SwapMode, getCurrentPoint, derivePositionAddress, deriveTokenVaultAddress } from '@meteora-ag/cp-amm-sdk'
import { createGraduatedFees } from './graduated-fees.mjs'

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const REINVEST_RULES = Object.freeze({ version: 1, maxSlippageBps: 100, maxPriceImpactBps: 50, maxNetworkCostLamports: '12000000' })
export const json = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v)
export const digest = value => createHash('sha256').update(json(value)).digest('hex')
export function agree(a, b) {
  if (json(a) !== json(b)) throw Error('RPC disagreement; wait for consistent finalized evidence')
  return a
}
export async function assertReinvestNetwork(connection, verification, env = process.env) {
  if (!verification) throw Error('Independent verification RPC is required')
  const genesis = agree(...await Promise.all([connection.getGenesisHash(), verification.getGenesisHash()]))
  const local = [connection, verification].every(c => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(c.rpcEndpoint))
  if (local && genesis !== MAINNET_GENESIS && env.NODE_ENV !== 'production' && env.BUILDER_REINVEST_LOCAL_REHEARSAL === 'true') return 'localnet'
  if (genesis !== MAINNET_GENESIS || connection.rpcEndpoint === verification.rpcEndpoint) throw Error('Reinvest requires mainnet and independent RPC verification')
  return 'mainnet'
}
export async function agreedTransaction(connection, verification, signature) {
  const receipts = await Promise.all([connection, verification].map(c => c.getTransaction(signature, {commitment: 'finalized', maxSupportedTransactionVersion: 0})))
  agree(...receipts.map(tx => tx && {slot: tx.slot, message: tx.transaction.message.serialize().toString('base64'), signatures: tx.transaction.signatures, meta: tx.meta}))
  return receipts[0]
}
export async function canonicalReinvestPool(connection, verification, config, market) {
  const snapshots = await Promise.all([connection, verification].map(c => createGraduatedFees({connection: c, config}).read(market)))
  if (snapshots.some(s => !s)) throw Error('Repository has not graduated')
  const [a,b] = snapshots
  agree(a.pool.toBase58(), b.pool.toBase58())
  // Mutable state must also agree; drift is a retryable unavailable quote, never guessed.
  const accounts = await Promise.all([connection, verification].map(c => c.getAccountInfo(a.pool, 'finalized')))
  agree(...accounts.map(x => x && {owner:x.owner.toBase58(), data:x.data.toString('base64')}))
  const amm = new CpAmm(connection), state = amm._program.coder.accounts.decode('pool', accounts[0].data)
  if (state.tokenAMint.toBase58() !== market.mint || !state.tokenBMint.equals(NATIVE_MINT) || state.collectFeeMode !== 1) throw Error('Unsupported repo pool assets')
  const mints = await Promise.all([connection,verification].map(c=>c.getAccountInfo(state.tokenAMint,'finalized')))
  agree(...mints.map(x=>x&&{owner:x.owner.toBase58(),data:x.data.toString('base64')}))
  const mint = mints[0]
  if (!mint?.owner.equals(TOKEN_PROGRAM_ID)) throw Error('Unsupported repo token program')
  return {pool:a.pool, state, amm}
}
export async function reinvestQuote(connection, snapshot, amount, rules = REINVEST_RULES) {
  const {amm,state} = snapshot, swapAmount = BigInt(amount)/2n
  if (swapAmount <= 0n) throw Error('Reinvestment amount is too small')
  const quote = amm.getQuote2({inputTokenMint:NATIVE_MINT,poolState:state,currentPoint:await getCurrentPoint(connection,state.activationType),
    amountIn:new BN(String(swapAmount)),slippage:rules.maxSlippageBps/100,swapMode:SwapMode.ExactIn,tokenADecimal:6,tokenBDecimal:9,hasReferral:false})
  const before=BigInt(state.sqrtPrice.toString())**2n, after=BigInt(quote.nextSqrtPrice.toString())**2n
  const impact=(after-before)*10000n
  if (impact<0n || (impact+before-1n)/before>BigInt(rules.maxPriceImpactBps)) throw Error('Reinvestment price impact exceeds the limit')
  const minA=quote.minimumAmountOut, maxB=new BN(String(BigInt(amount)-swapAmount))
  const liquidity=amm.getLiquidityDelta({maxAmountTokenA:minA,maxAmountTokenB:maxB,sqrtPrice:quote.nextSqrtPrice,
    sqrtMinPrice:state.sqrtMinPrice,sqrtMaxPrice:state.sqrtMaxPrice,collectFeeMode:state.collectFeeMode}).muln(9999).divn(10000)
  if (minA.lten(0)||liquidity.lten(0)) throw Error('Reinvestment amount is too small')
  return {swapAmount:String(swapAmount),outputAmount:quote.outputAmount.toString(),minA:minA.toString(),maxB:maxB.toString(),liquidity:liquidity.toString(),
    minimumLiquidity:liquidity.muln(10000-rules.maxSlippageBps).divn(10000).toString(),sqrtPrice:state.sqrtPrice.toString()}
}
export function assertFreshReinvestQuote(terms, fresh) {
  // The reviewed slippage already bounds execution. Do not apply it twice to a fresh quote.
  if(BigInt(fresh.outputAmount)<BigInt(terms.min_swap_output)||BigInt(fresh.liquidity)<BigInt(terms.minimum_liquidity)) throw Error('Stale quote; cancel and review a new quote')
}
export async function buildReinvestTransaction(connection, snapshot, ownerAddress, quote) {
  const owner=new PublicKey(ownerAddress), nft=Keypair.generate(), {amm,state,pool}=snapshot
  const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:500000}))
  tx.add(await amm.swap2({payer:owner,pool,inputTokenMint:NATIVE_MINT,outputTokenMint:state.tokenAMint,
    tokenAMint:state.tokenAMint,tokenBMint:state.tokenBMint,tokenAVault:state.tokenAVault,tokenBVault:state.tokenBVault,
    tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID,referralTokenAccount:null,swapMode:SwapMode.ExactIn,
    amountIn:new BN(quote.swapAmount),minimumAmountOut:new BN(quote.minA)}))
  tx.add(await amm.createPositionAndAddLiquidity({owner,pool,positionNft:nft.publicKey,liquidityDelta:new BN(quote.liquidity),
    maxAmountTokenA:new BN(quote.minA),maxAmountTokenB:new BN(quote.maxB),tokenAAmountThreshold:new BN(quote.minA),tokenBAmountThreshold:new BN(quote.maxB),
    tokenAMint:state.tokenAMint,tokenBMint:state.tokenBMint,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID}))
  const latest=await connection.getLatestBlockhash('confirmed')
  tx.feePayer=owner; tx.recentBlockhash=latest.blockhash
  // Only the fresh position NFT is signed here. Builder funds require the wallet signature.
  tx.partialSign(nft)
  return {tx,latest,nft:nft.publicKey.toBase58(),position:derivePositionAddress(nft.publicKey).toBase58()}
}
export async function simulateReinvest(connection, verification, tx, terms, signed = false) {
  const owner=new PublicKey(terms.source_wallet)
  const addresses=[owner,getAssociatedTokenAddressSync(NATIVE_MINT,owner),deriveTokenVaultAddress(NATIVE_MINT,new PublicKey(terms.pool))]
  const results=await Promise.all([connection,verification].map(async rpc => {
    const before=await rpc.getMultipleAccountsInfo(addresses,'confirmed')
    const transaction=VersionedTransaction.deserialize(tx.serialize({requireAllSignatures:false,verifySignatures:false}))
    const result=await rpc.simulateTransaction(transaction,{sigVerify:signed,commitment:'confirmed',accounts:{encoding:'base64',addresses:addresses.map(k=>k.toBase58())}})
    if(result.value.err) throw Error('Reinvestment simulation failed; check balance and refresh the quote')
    const after=result.value.accounts
    if(!before[2]||!after?.[0]||!after[2]) throw Error('Reinvestment simulation evidence is unavailable')
    const debit=before.slice(0,2).reduce((s,a)=>s+BigInt(a?.lamports??0),0n)-after.slice(0,2).reduce((s,a)=>s+BigInt(a?.lamports??0),0n)
    const economic=BigInt(after[2].lamports)-BigInt(before[2].lamports),overhead=debit-economic
    if(economic<=0n||economic>BigInt(terms.source_amount)||overhead<0n||overhead>BigInt(terms.max_network_cost)) throw Error('Reinvestment simulation exceeds the reviewed budget')
    return {broadcast:false,economicDebit:String(economic),networkCost:String(overhead),walletDebit:String(debit)}
  }))
  return agree(...results)
}
