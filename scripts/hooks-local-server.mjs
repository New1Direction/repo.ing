// Local HTTPS host for the REAL Next routes and byte-transparent local-validator RPC.
import { createServer } from 'node:https'
import { readFile, appendFile } from 'node:fs/promises'
import { VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { stateDirectory } from './hooks-local-common.mjs'
const state=stateDirectory(),chain=JSON.parse(await readFile(`${state}/local-chain.public.json`,'utf8'))
if(process.env.NODE_ENV==='production'||process.env.NODE_EXTRA_CA_CERTS!==`${state}/local-cert.pem`)throw Error('Use the explicit local development TLS setup')
Object.assign(process.env,{NODE_ENV:'development',HOOK_LOCAL_ACCEPTANCE:'true',HOOK_LOCAL_ACCEPTANCE_GENESIS:chain.genesisHash,
 HOOK_WALLET_IDENTITY_ENABLED:'true',HOOK_NATIVE_LAUNCH_ENABLED:'true',HOOK_INCLUSIVE_TRADING_ENABLED:'true',
 HOOK_WALLET_IDENTITY_ORIGIN:'https://localhost:3443',HOOK_WALLET_IDENTITY_DATABASE_URL:chain.databaseUrl,
 HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY:'https://127.0.0.1:18898',HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY:'https://127.0.0.1:18899',
 NEXT_PUBLIC_HOOK_LOCAL_TEST_WALLET:'true',APP_ORIGIN:'https://localhost:3443'})
const {localAcceptanceNetwork}=await import('../src/hooklab-local-acceptance.mjs'),network=localAcceptanceNetwork()
const tls={key:await readFile(`${state}/local-key.pem`),cert:await readFile(`${state}/local-cert.pem`)}
const methods=new Set(['getGenesisHash','getVersion','getSlot','getBlockHeight','getLatestBlockhash','getMinimumBalanceForRentExemption','getMultipleAccounts','getAccountInfo',
 'getFeeForMessage','isBlockhashValid','simulateTransaction','sendTransaction','getTransaction','getBlock','getSignatureStatuses','getBalance'])
let loseNextSend=false
const submissions=new Map()
async function body(request,max=20000){const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>max)throw Error('Local request too large');chunks.push(chunk)}return JSON.parse(Buffer.concat(chunks))}
const proxies=await Promise.all([18898,18899].map(port=>new Promise((resolve,reject)=>{
 const server=createServer(tls,async(request,response)=>{
  try{
   if(request.method!=='POST'||request.url!=='/')throw Error('Local RPC POST only')
   const input=await body(request)
   if(!methods.has(input.method)||input.jsonrpc!=='2.0')throw Error('Local RPC method not enabled')
   let signature
   if(input.method==='sendTransaction'){
    signature=bs58.encode(VersionedTransaction.deserialize(Buffer.from(input.params[0],'base64')).signatures[0])
    submissions.set(signature,(submissions.get(signature)??0)+1)
    await appendFile(`${state}/rpc-send-audit.jsonl`,JSON.stringify({at:new Date().toISOString(),signature,attempt:submissions.get(signature),localProxyPort:port})+'\n',{mode:0o600})
   }
   // Fixed upstream. No URL, cluster, provider or redirect comes from a request.
   const upstream=await fetch('http://127.0.0.1:18999',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(15000)})
   const bytes=Buffer.from(await upstream.arrayBuffer())
   if(signature&&loseNextSend){loseNextSend=false;response.destroy();return}
   response.writeHead(upstream.status,{'content-type':'application/json','cache-control':'no-store'});response.end(bytes)
  }catch{if(!response.headersSent)response.writeHead(502,{'content-type':'application/json'});response.end(JSON.stringify({error:'Local validator request unavailable'}))}
 })
 server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server))
})))
const {bootstrapLocalHooks}=await import('./hooks-local-bootstrap.mjs')
await bootstrapLocalHooks()
const {default:next}=await import('next')
let handle
const server=createServer(tls,async(request,response)=>{
 try{
  if(request.method==='GET'&&request.url==='/__local/metadata.json'){
   response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
   response.end(JSON.stringify({name:'Hook Lab local acceptance',symbol:'HLLOCAL',description:'Synthetic unbacked LOCAL-test assets only. Never fund the public test keys or use this mint on mainnet.'}));return
  }
  if(request.url==='/__local/control'){
   response.setHeader('content-type','application/json');response.setHeader('cache-control','no-store')
   if(request.method==='POST'){
    if(request.headers.origin!==network.origin||request.headers['content-type']!=='application/json'||request.headers['sec-fetch-site']==='cross-site')throw Error('Local control origin mismatch')
    const control=await body(request,1024)
    if(Object.keys(control).length!==1||control.loseNextSendResponse!==true)throw Error('Unknown local fault control')
    loseNextSend=true
   }else if(request.method!=='GET')throw Error('Local control method unavailable')
   response.end(JSON.stringify({scope:'LOCAL-ONLY',loseNextSendResponse:loseNextSend,submissions:[...submissions].map(([signature,attempts])=>({signature,attempts}))}));return
  }
  await handle(request,response)
 }catch{if(!response.headersSent)response.writeHead(400);response.end('Local request refused')}
})
const app=next({dev:true,hostname:'localhost',port:3443,httpServer:server,webpack:true})
await app.prepare();handle=app.getRequestHandler()
server.listen(3443,'127.0.0.1',()=>console.log(`HOOKS_LOCAL_READY ${network.origin}/hooks/launch-review`))
async function stop(){for(const proxy of proxies)proxy.close();server.close();await app.close();process.exit(0)}
process.on('SIGTERM',stop);process.on('SIGINT',stop)
