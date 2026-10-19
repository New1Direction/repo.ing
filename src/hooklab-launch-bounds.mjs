// The live launch config's virtual-quote limits, read-only: the same account (derivedAddresses().launchConfig) and the
// same pinned Config decoder the owner driver uses, from two RPC providers that must return identical finalized bytes.
// An invite whose opening quote the chain would refuse is never recorded: it would hold the single invite slot.
import { PublicKey } from '@solana/web3.js'
import { loadArtifacts } from './hooklab-owner-driver/artifacts.mjs'
import { PROGRAMS,derivedAddresses } from './hooklab-owner-driver/pins.mjs'
import { STANDARD_VIRTUAL_QUOTE,formatSol } from './hooklab-launch-pricing.mjs'
const refuse=message=>Object.assign(Error(message),{code:'LAUNCH_PRICE_REFUSED'})
const need=(ok,message)=>{if(!ok)throw refuse(message)}

// connections: two objects with getAccountInfo(PublicKey, commitment), e.g. @solana/web3.js Connections.
export async function readLiveLaunchBounds(connections,{programs=PROGRAMS}={}){
 need(Array.isArray(connections)&&connections.length===2,'Two RPC providers are needed to read the on-chain launch limits')
 const address=new PublicKey(derivedAddresses(programs).launchConfig)
 // Provider errors can carry the RPC URL and its API key; only a fixed message leaves here.
 let infos;try{infos=await Promise.all(connections.map(c=>c.getAccountInfo(address,'finalized')))}catch{throw refuse('Could not read the on-chain launch limits; try the invite again')}
 need(infos.every(i=>i&&i.owner.toBase58()===programs.launch),'The launch config is missing on chain; try the invite again')
 need(Buffer.from(infos[0].data).equals(Buffer.from(infos[1].data)),'The RPC providers disagree on the launch config; try the invite again')
 const config=loadArtifacts().coders.launch.accounts.decode('Config',Buffer.from(infos[0].data))
 return Object.freeze({min:BigInt(config.min_virtual_quote.toString()),max:BigInt(config.max_virtual_quote.toString())})
}

export function checkLiveBounds(virtualQuote,bounds){
 need(bounds&&typeof bounds.min==='bigint'&&typeof bounds.max==='bigint','On-chain launch limits are unavailable; try the invite again')
 const quote=BigInt(virtualQuote),range=`${formatSol(bounds.min,9).replace(' SOL','')}–${formatSol(bounds.max,9)}`
 need(quote>=bounds.min&&quote<=bounds.max,`On-chain limits are ${range}, but this launch would open at ${formatSol(quote)}. ${String(virtualQuote)===STANDARD_VIRTUAL_QUOTE
  ?'Deploy with HOOK_LAUNCH_USD_PRICING=true first.':'Sign the launch-usd-bounds change first.'}`)
}
