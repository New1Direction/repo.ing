import { PublicKey } from '@solana/web3.js'
import { readGenesisHash } from './rpc-usage.mjs'
import { pendingDelivery } from './reserve-alerts.mjs'
const MAINNET='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const OPERATING_WALLETS=[
  {key:'OPS_PAYOUT_WALLET',role:'Builder payout signer',minimumLamports:'30000000'},
  {key:'OPS_COLLECTION_WALLET',role:'Platform collection signer',minimumLamports:'10000000'},
]
export function operatingWalletObservation(role, minimumLamports, readings) {
  if(readings.length!==2||readings.some(r=>r.genesis!==MAINNET||!Number.isSafeInteger(r.slot)||r.slot<=0||!Number.isSafeInteger(r.balance)||r.balance<0)||
    Math.abs(readings[0].slot-readings[1].slot)>150||readings[0].balance!==readings[1].balance)throw Error('OPERATING_WALLET_RPC_DISAGREEMENT')
  return {role,minimumLamports,balanceLamports:String(readings[0].balance),low:BigInt(readings[0].balance)<BigInt(minimumLamports),slots:readings.map(r=>r.slot)}
}
export function createOperatingWalletMonitor({pool,connections,env=process.env,now=Date.now}) {
  return {async runOnce(){
    if(connections.length!==2||!env.SOLANA_RPC_URL||!env.GRADUATION_VERIFICATION_RPC_URL||env.SOLANA_RPC_URL===env.GRADUATION_VERIFICATION_RPC_URL||OPERATING_WALLETS.some(w=>!env[w.key]))return {status:'CONFIGURATION_REQUIRED'}
    const results=[]
    for(const {key,role,minimumLamports} of OPERATING_WALLETS){
      const wallet=new PublicKey(env[key])
      const readings=await Promise.all(connections.map(async c=>{
        const [genesis,balance]=await Promise.all([readGenesisHash(c),c.getBalanceAndContext(wallet,'finalized')])
        return {genesis,slot:balance.context.slot,balance:balance.value}
      }))
      const state=operatingWalletObservation(role,minimumLamports,readings),time=now()
      if(state.low){
        const observedAt=new Date(time).toISOString()
        const detail={...state,observedAt,delivery:pendingDelivery(time)}
        // Durable daily dedup survives restarts and simultaneous worker replicas.
        await pool.query(`insert into graduation_alerts(event_key,kind,detail) values($1,'OPS_WALLET_LOW',$2) on conflict(event_key) do nothing`,
          [`ops-wallet-low:${key}:${observedAt.slice(0,10)}`,JSON.stringify(detail)])
      }
      results.push(state)
    }
    return {status:results.some(r=>r.low)?'LOW_BALANCE':'OK',wallets:results}
  }}
}
