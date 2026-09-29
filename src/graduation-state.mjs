import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMarketConfigResolver } from './market-config.mjs'
import { createGraduatedFees, migrationPosition } from './graduated-fees.mjs'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'

const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const GRADUATION_MAX_AGE_MS = 120_000
// Providers may serialize object properties in different orders. Array order and
// every economic/instruction value remain significant for agreement and hashes.
export const evidenceJSON = value => JSON.stringify(value, (_key,v) => typeof v === 'bigint' ? String(v) :
  v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v)
export const evidenceHash = value => createHash('sha256').update(evidenceJSON(value)).digest('hex')
export function agreeGraduation(a,b) {
  if (evidenceJSON(a)!==evidenceJSON(b)) throw Error('RPC_DISAGREEMENT')
  return a
}
export function graduationProgress(reserve, threshold, migrated = false) {
  const current=BigInt(reserve),target=BigInt(threshold)
  if(current<0n||target<=0n)throw Error('INVALID_THRESHOLD')
  return {phase:migrated?'GRADUATED':'CURVE',status:migrated?'graduated':current>=target?'migrating':'active',
    reserveLamports:String(current),thresholdLamports:String(target),remainingLamports:String(migrated||current>=target?0n:target-current),
    progressPercent:migrated||current>=target?100:Number(current*10000n/target)/100}
}
export function assertFreshGraduation(value, now=Date.now()) {
  const checked=Date.parse(value?.checkedAt),chainTime=Date.parse(value?.chainTime)
  if(!Number.isFinite(checked)||!Number.isFinite(chainTime)||now-checked>GRADUATION_MAX_AGE_MS||now-chainTime>GRADUATION_MAX_AGE_MS||checked>now+5000||chainTime>now+5000)throw Error('STALE_PROGRESS')
  return value
}
const accountEvidence = (info,address) => {
  if(!info)throw Error('ACCOUNT_MISSING')
  return {address:address.toBase58(),owner:info.owner.toBase58(),data:info.data.toString('base64')}
}
export async function agreedFinalizedTransaction(connection,verification,signature) {
  const receipts=await Promise.all([connection,verification].map(c=>loadFinalizedTransaction(c,signature)))
  // RPC optional metadata can differ; all ordering, instructions and economic balances must agree.
  const canonical=tx=>tx&&{slot:tx.slot,blockTime:tx.blockTime,version:tx.version,transaction:tx.transaction,error:tx.meta.err,
    preBalances:tx.meta.preBalances,postBalances:tx.meta.postBalances,preTokenBalances:tx.meta.preTokenBalances,
    postTokenBalances:tx.meta.postTokenBalances,innerInstructions:tx.meta.innerInstructions,fee:tx.meta.fee}
  agreeGraduation(...receipts.map(canonical))
  if(!receipts[0]?.meta||receipts[0].meta.err)throw Error('MIGRATION_EVIDENCE_INCOMPLETE')
  return receipts[0]
}

// No in-process estimate/cache. The worker persists only independently verified finalized observations.
export async function readGraduationState({connection,verification,config,market,env=process.env,db=null}) {
  if(!verification)throw Error('VERIFICATION_RPC_REQUIRED')
  const local=[connection,verification].every(c=>/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(c.rpcEndpoint))
  if(connection.rpcEndpoint===verification.rpcEndpoint&&!(local&&env.NODE_ENV!=='production'))throw Error('INDEPENDENT_RPC_REQUIRED')
  const genesis=agreeGraduation(...await Promise.all([connection,verification].map(c=>c.getGenesisHash())))
  if(genesis!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'&&!(local&&env.NODE_ENV!=='production'))throw Error('NETWORK_MISMATCH')
  const configKey=createMarketConfigResolver(config)(market),poolKey=new PublicKey(market.pool)
  const addresses=[poolKey,configKey]
  const reads=await Promise.all([connection,verification].map(async c=>{
    const snapshot=await c.getMultipleAccountsInfoAndContext(addresses,'finalized')
    const time=await c.getBlockTime(snapshot.context.slot)
    if(!time)throw Error('STALE_PROGRESS')
    const evidence=snapshot.value.map((info,i)=>accountEvidence(info,addresses[i]))
    if(snapshot.value.some(a=>!a?.owner.equals(DBC)))throw Error('CONFIG_OR_POOL_OWNER_MISMATCH')
    return {snapshot,evidence,time}
  }))
  agreeGraduation(...reads.map(r=>r.evidence))
  const dbc=new DynamicBondingCurveClient(connection,'finalized'),coder=dbc.state.getProgram().coder.accounts
  const state=coder.decode('virtualPool',reads[0].snapshot.value[0].data).poolState,fixed=coder.decode('poolConfig',reads[0].snapshot.value[1].data)
  if(!state.config.equals(configKey)||state.baseMint.toBase58()!==market.mint||state.creator.toBase58()!==market.creatorWallet||!fixed.quoteMint.equals(NATIVE_MINT))throw Error('CONFIG_OR_POOL_MISMATCH')
  const value={...graduationProgress(state.quoteReserve.toString(),fixed.migrationQuoteThreshold.toString()),
    repoId:String(market.githubRepoId??market.repoId),config:configKey.toBase58(),curve:market.pool,mint:market.mint,
    checkedAt:new Date().toISOString(),chainTime:new Date(Math.min(...reads.map(r=>r.time))*1000).toISOString(),
    slots:reads.map(r=>r.snapshot.context.slot),accountEvidence:reads[0].evidence,destination:null}
  assertFreshGraduation(value)
  if(!state.isMigrated)return value
  const snapshots=await Promise.all([connection,verification].map(c=>createGraduatedFees({connection:c,config,db}).read(market,{poolState:state},fixed)))
  if(snapshots.some(s=>!s))throw Error('GRADUATION_STATE_DISAGREEMENT')
  agreeGraduation(...snapshots.map(s=>({evidence:s.evidence,partner:s.partner.evidence})))
  const g=snapshots[0]
  if(g.poolState.poolStatus!==0)throw Error('DAMM_POOL_DISABLED')
  const tx=await agreedFinalizedTransaction(connection,verification,g.evidence.migration)
  const proof=migrationPosition(tx,market,configKey,g.pool)
  if(!proof||!proof.position.equals(g.position)||!proof.partner.position.equals(g.partner.position)||tx.slot>Math.min(...reads.map(r=>r.snapshot.context.slot)))throw Error('MIGRATION_EVIDENCE_INCOMPLETE')
  const balances=side=>({native:tx.transaction.message.accountKeys.map((k,i)=>({address:k.toBase58(),lamports:String(tx.meta[`${side}Balances`][i])})),tokens:tx.meta[`${side}TokenBalances`]})
  value.migration={signature:g.evidence.migration,slot:tx.slot,blockTime:tx.blockTime,
    curve:market.pool,config:value.config,mint:market.mint,pool:g.pool.toBase58(),
    creatorPosition:g.position.toBase58(),partnerPosition:g.partner.position.toBase58(),
    transactionHash:evidenceHash(tx.transaction),pre:balances('pre'),post:balances('post')}
  value.migrationHash=evidenceHash(value.migration)
  value.positionEvidence={creator:g.evidence,partner:g.partner.evidence}
  Object.assign(value,graduationProgress(state.quoteReserve.toString(),fixed.migrationQuoteThreshold.toString(),true),{
    destination:{pool:g.pool.toBase58(),url:`https://app.meteora.ag/dammv2/${g.pool.toBase58()}`},
    dammSolLamports:g.poolState.tokenBAmount.toString(),partnerWallet:fixed.feeClaimer.toBase58(),
    platform:{earned:String(g.partner.earned),claimed:String(g.partner.claimed),available:String(g.partner.available)}})
  return assertFreshGraduation(value)
}
