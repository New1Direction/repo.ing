import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createMarketPrefetch } from '../app/lib/market-prefetch.mjs'
import { loadTradePreview } from '../app/lib/trade-preview.mjs'
import { watchMarketEvents } from '../app/lib/market-events.mjs'
import { createMarketNotifications, parseMarketNotification, MARKET_CHANNEL, STOCK_MARKET_CHANNEL } from '../src/market-notifications.mjs'
const mint = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const other = '9RnMkXRLtkpMSWSCfgbUoGsYmJovAgEgJ7z8sHnwbaHk'
const flush = () => new Promise(resolve => setImmediate(resolve))
const response = value => ({ ok: true, json: async () => value })
const cost = { networkFee:'1',accountDeposits:'0',refundableDeposit:'0',total:'11',required:'11',shortfall:'0' }

test('price appears before delayed costs; a failed cost preview cannot hide the quote', async () => {
  let finishCosts, shown, costs
  const pending = loadTradePreview({ request:{wallet:mint},signal:new AbortController().signal,
    fetcher: async (_, options) => JSON.parse(options.body).action === 'costs' ? new Promise(resolve => { finishCosts=resolve }) : response({outputAmount:'42',minimumAmountOut:'40'}),
    onQuote: value => {shown=value},onQuoteError: assert.fail,onCosts:value=>{costs=value} })
  await flush(); assert.equal(shown.outputAmount,'42'); assert.equal(costs,undefined)
  finishCosts({ok:false,json:async()=>({error:'RPC timeout'})});await pending
  assert.equal(shown.outputAmount,'42');assert.equal(costs.unavailable,true)
})
test('aborted amount/wallet generation cannot deliver either stale preview',async()=>{
  let resolveCost, resolveQuote
  const controller=new AbortController()
  const pending=loadTradePreview({request:{wallet:mint},signal:controller.signal,fetcher:(_,o)=>new Promise(resolve=>{if(JSON.parse(o.body).action==='costs')resolveCost=resolve;else resolveQuote=resolve}),onQuote:assert.fail,onQuoteError:assert.fail,onCosts:assert.fail})
  controller.abort();resolveCost(response({costs:cost}));resolveQuote(response({outputAmount:'42',minimumAmountOut:'40'}));await pending
})
test('public cache coalesces intent requests, expires and cannot cross mints',async()=>{
  let now=10000,calls=0
  const cache=createMarketPrefetch({now:()=>now,ttl:8000,limit:1,fetcher:async()=>{calls++;return response({range:'all',candles:[],fetchedAt:new Date(now).toISOString()})}})
  await Promise.all([cache.warm(mint),cache.warm(mint)]);assert.equal(calls,1);assert.equal(cache.take(other),null);assert.ok(cache.take(mint))
  await cache.warm(mint);now+=8001;assert.equal(cache.take(mint),null)
  await cache.warm(mint);await cache.warm(other);assert.equal(cache.take(mint),null);assert.ok(cache.take(other))
  await cache.warm('../secrets');assert.equal(calls,4)
})
test('cache rejects stale server evidence and handles unavailable history',async()=>{
  const cache=createMarketPrefetch({now:()=>100000,fetcher:async()=>response({range:'all',candles:[],fetchedAt:new Date(0).toISOString()})})
  await cache.warm(mint);assert.equal(cache.take(mint),null)
})
test('event parser rejects private/invalid/misclassified payloads',()=>{
  assert.equal(parseMarketNotification('{}'),null);assert.equal(parseMarketNotification('invalid'),null)
  assert.equal(parseMarketNotification(JSON.stringify({mint,kind:'balance'})),null)
  assert.deepEqual(parseMarketNotification(JSON.stringify({mint,kind:'trade',balance:'SECRET'})),{mint,kind:'trade'})
  // The SOL channel keeps its two kinds; a stock pair's trade and fee hints (migration 0054) both refresh as 'trade'.
  assert.equal(parseMarketNotification(JSON.stringify({mint,kind:'fee'})),null)
  assert.deepEqual(parseMarketNotification(JSON.stringify({mint,kind:'fee'}),STOCK_MARKET_CHANNEL),{mint,kind:'trade'})
  assert.deepEqual(parseMarketNotification(JSON.stringify({mint,kind:'trade',amount:'1'}),STOCK_MARKET_CHANNEL),{mint,kind:'trade'})
  for(const bad of [{mint,kind:'curve'},{mint:'not-a-mint',kind:'trade'},{kind:'fee'}])assert.equal(parseMarketNotification(JSON.stringify(bad),STOCK_MARKET_CHANNEL),null)
})
test('one DB listener fans out to the correct market, reconnects and cleans up',async()=>{
  const clients=[];let count=0
  class FakeClient extends EventEmitter {async connect(){} async query(sql){(this.listens??=[]).push(sql)} async end(){this.ended=true}}
  const hub=createMarketNotifications({makeClient:()=>{const c=new FakeClient();clients.push(c);return c},retryMs:5,idleMs:5})
  const seen=[];const stop=hub.subscribe(mint,event=>seen.push(event));const stopOther=hub.subscribe(other,()=>count++)
  await flush();assert.equal(clients.length,1);assert.equal(seen[0].kind,'resync');assert.equal(count,1)
  assert.deepEqual(clients[0].listens,[`LISTEN ${MARKET_CHANNEL}`,`LISTEN ${STOCK_MARKET_CHANNEL}`])
  clients[0].emit('notification',{channel:MARKET_CHANNEL,payload:JSON.stringify({mint,kind:'trade'})})
  assert.equal(seen.at(-1).kind,'trade');assert.equal(count,1)
  // A stock pair's fee hint reaches its own market's listeners as a trade; other channels are ignored.
  clients[0].emit('notification',{channel:STOCK_MARKET_CHANNEL,payload:JSON.stringify({mint,kind:'fee'})})
  assert.deepEqual(seen.at(-1),{mint,kind:'trade'});assert.equal(seen.length,3);assert.equal(count,1)
  clients[0].emit('notification',{channel:'some_other_channel',payload:JSON.stringify({mint,kind:'trade'})});assert.equal(seen.length,3)
  clients[0].emit('error',Error('network'));await new Promise(r=>setTimeout(r,15));assert.equal(clients.length,2);assert.equal(seen.at(-1).kind,'resync')
  stop();stop();stopOther();await new Promise(r=>setTimeout(r,15));assert.equal(clients[1].ended,true);hub.close()
})
test('hidden tabs close live streams and resume only their own market',()=>{
  const page=new EventTarget();page.visibilityState='visible';const target=new EventTarget();const sources=[],seen=[]
  class Source extends EventTarget{constructor(url){super();this.url=url;sources.push(this)}close(){this.closed=true}}
  target.addEventListener('repoing:market-updated',e=>seen.push(e.detail))
  const stop=watchMarketEvents(mint,{page,target,EventSourceClass:Source})
  const emit=(source,data)=>source.dispatchEvent(Object.assign(new Event('market'),{data:JSON.stringify(data)}))
  emit(sources[0],{mint:other,kind:'trade'});assert.equal(seen.length,0)
  emit(sources[0],{mint,kind:'trade'});assert.equal(seen.length,1)
  page.visibilityState='hidden';page.dispatchEvent(new Event('visibilitychange'));assert.ok(sources[0].closed)
  emit(sources[0],{mint,kind:'trade'});assert.equal(seen.length,1)
  page.visibilityState='visible';page.dispatchEvent(new Event('visibilitychange'));assert.equal(sources.length,2)
  stop();assert.ok(sources[1].closed)
})
