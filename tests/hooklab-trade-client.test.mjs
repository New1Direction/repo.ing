// Trade panel logic: amounts, plans and estimates (pure), and the runner that signs exactly the reviewed bytes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js'
import { estimateTrade, formatUnits, maxBuyLamports, nativeTradeIntent, parseUnits, planBuy, planSell, sol, tradeButton, tradeIntent } from '../app/lib/hooklab-trade-math.mjs'
import { createInclusiveTradeHandler } from '../app/lib/hooklab-inclusive-trade.mjs'
import { runOperation, pendingOperations, rememberOperation, forgetOperation } from '../app/lib/hooklab-trade-runner.mjs'

const market = { creatorFeeBps: 100, capBps: 200, initialSupply: '1000000000000000',
  pool: { baseReserve: '750000000000000', quoteReserve: '1', virtualBase: '375000000000000', virtualQuote: '1000000000', protocolFeesQuote: '0' } }

test('selected-hook preview has no fabricated gate cap and preserves hook identity in native intent', () => {
  const selectedHook={program:Keypair.generate().publicKey.toBase58(),flags:3}
  const selected={...market,policyKind:'selected-hook',capBps:0,selectedHook}
  const preview=estimateTrade(selected,{side:'buy',amount:30_000_000n,coinBalance:100_000_000_000_000n})
  assert.equal(preview.error,undefined)
  const gross=29_700_000n*1_125_000_000_000_000n/1_029_700_001n
  assert.equal(preview.delivered,gross)
  assert.equal(preview.hookDeductionsUnmeasured,true)
  assert.match(estimateTrade({...market,capBps:0},{side:'buy',amount:30_000_000n}).error,/can’t be traded/)
  assert.deepEqual(nativeTradeIntent(selected,'buy',30_000_000n,preview.minAmountOut,false),{
    ...tradeIntent(selected,'buy',30_000_000n,preview.minAmountOut),graduate:false,policyKind:'selected-hook',selectedHook})
})

test('amounts parse exactly and format plainly', () => {
  assert.equal(parseUnits('0.05', 9), 50_000_000n); assert.equal(parseUnits('1', 9), 1_000_000_000n); assert.equal(parseUnits('.5', 6), 500_000n)
  for (const bad of ['', '0', '0.0', '-1', '1e3', '0.0000000001', 'abc', '1.2.3']) assert.equal(parseUnits(bad, 9), null, bad)
  assert.equal(formatUnits(50_000_000n, 9), '0.05'); assert.equal(formatUnits(1_234_567_000_000n, 6, 2), '1,234,567'); assert.equal(sol(1_686_560n), '0.0016 SOL')
})

test('a first buy adds SOL (with both holding deposits) then swaps; later buys reuse what is in Hook Lab', () => {
  const fresh = planBuy({ amount: 50_000_000n, wallet: { lamports: '100000000', bridgedSol: null, coin: null }, rentLamports: '1686560' })
  assert.deepEqual(fresh.steps.map(s => s.kind), ['fund', 'buy'])
  assert.equal(fresh.steps[0].lamports, 50_000_000n); assert.equal(fresh.steps[0].rentLamports, 3_373_120n)
  assert.equal(fresh.walletCost, 50_000_000n + 3_373_120n + 7000n + 19000n); assert.equal(fresh.shortfall, 0n)
  const topped = planBuy({ amount: 50_000_000n, wallet: { lamports: '100000000', bridgedSol: '60000000', coin: '0' }, rentLamports: '1686560' })
  assert.deepEqual(topped.steps.map(s => s.kind), ['buy']); assert.equal(topped.fromHookLab, 50_000_000n)
  const partial = planBuy({ amount: 50_000_000n, wallet: { lamports: '100000000', bridgedSol: '20000000', coin: null }, rentLamports: '1686560' })
  assert.equal(partial.steps[0].lamports, 30_000_000n); assert.equal(partial.steps[0].rentLamports, 1_686_560n)
  assert.ok(planBuy({ amount: 99_000_000n, wallet: { lamports: '100000000', bridgedSol: null, coin: null }, rentLamports: '1686560' }).shortfall > 0n, 'not enough SOL is caught before signing')
  assert.deepEqual(planSell({ amount: 5n, wallet: { lamports: '100000' } }).steps.map(s => s.kind), ['sell', 'withdraw'])
})

test('estimates use the real quote model, apply slippage, and explain refusals', () => {
  const buy = estimateTrade(market, { side: 'buy', amount: 10_000_000n, slippageBps: 300 })
  assert.ok(buy.delivered > 0n && buy.minAmountOut === buy.delivered * 9700n / 10000n && buy.creatorFee === 100_000n)
  assert.match(estimateTrade(market, { side: 'buy', amount: 2_000_000_000n }).error, /max per wallet/)
  assert.match(estimateTrade(market, { side: 'buy', amount: 10_000_000n, coinBalance: 20_000_000_000_000n }).error, /max per wallet/)
  const sell = estimateTrade({ ...market, pool: { ...market.pool, baseReserve: '740000000000000', quoteReserve: '10000000' } }, { side: 'sell', amount: 1_000_000_000_000n })
  assert.ok(sell.delivered > 0n)
})

// A fake server and wallet: the runner must sign exactly the reviewed message and refuse any change.
function fixture({ tamper = null, finalStatus = 'finalized-success' } = {}) {
  const wallet = Keypair.generate(), signingId = '11111111-1111-4111-8111-111111111111', genesisHash = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
  const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: '11111111111111111111111111111111',
    instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message()
  const bytes = message.serialize(), messageBase64 = Buffer.from(bytes).toString('base64'), messageSha256 = createHash('sha256').update(bytes).digest('hex')
  const review = { genesisHash, wallet: wallet.publicKey.toBase58(), payer: wallet.publicKey.toBase58(), requiredSigners: [wallet.publicKey.toBase58()], messageBase64, messageSha256, reviewExpiresAtMs: Date.now() + 60000 }
  const calls = [], op = status => ({ operation: { id: signingId, custodyOperationId: signingId, status, review } })
  let polls = 0
  const call = async body => {
    calls.push(body.action)
    if (['fund', 'quote', 'withdraw'].includes(body.action)) return op('reviewed')
    if (body.action === 'wallet-request') return { review, partialTransactionBase64: Buffer.from(new VersionedTransaction(message).serialize()).toString('base64') }
    if (body.action === 'retain-wallet') { assert.ok(VersionedTransaction.deserialize(Buffer.from(body.signedTransactionBase64, 'base64')).signatures[0].some(v => v)); return op('signed') }
    if (body.action === 'submit') return op('submitted')
    if (body.action === 'reconcile') return op(++polls >= 2 ? finalStatus : 'submitted')
  }
  const signTransaction = async tx => { if (tamper) tamper(tx); tx.sign([wallet]); return tx }
  return { call, calls, signTransaction, ids: { signingId, wallet: wallet.publicKey.toBase58(), genesisHash } }
}

test('the runner reviews, signs once, sends once and confirms to a finalized receipt', async () => {
  const f = fixture(), statuses = []
  const result = await runOperation({ call: f.call, create: { action: 'fund', request: { mint: null, lamports: '1000' } }, ...f.ids, signTransaction: f.signTransaction,
    onStatus: s => statuses.push(s), sleep: async () => {}, loadTransaction: async () => VersionedTransaction })
  assert.equal(result.status, 'finalized-success')
  assert.deepEqual(f.calls, ['fund', 'wallet-request', 'retain-wallet', 'submit', 'reconcile', 'reconcile'])
  assert.deepEqual(statuses, ['review', 'sign', 'send', 'confirm'])
})

test('the runner refuses a wallet that changes the transaction, and a server that swaps the wallet', async () => {
  const changed = fixture({ tamper: tx => { tx.message.recentBlockhash = '11111111111111111111111111111112' } })
  await assert.rejects(runOperation({ call: changed.call, create: { action: 'withdraw', request: { lamports: '5' } }, ...changed.ids, signTransaction: changed.signTransaction,
    sleep: async () => {}, loadTransaction: async () => VersionedTransaction }), /changed the transaction/)
  assert.ok(!changed.calls.includes('submit'), 'nothing was sent')
  const f = fixture()
  await assert.rejects(runOperation({ call: f.call, create: { action: 'fund', request: { mint: null, lamports: '1' } }, ...f.ids, wallet: new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
    signTransaction: f.signTransaction, sleep: async () => {}, loadTransaction: async () => VersionedTransaction }), /wallet changed/)
})

test('selected trades need explicit consent for the exact message before requesting wallet bytes', async () => {
  for(const approve of [false,true]){
    const f=fixture(),create={action:'quote',request:{policyKind:'selected-hook'}},seen=[]
    const task=runOperation({call:f.call,create,...f.ids,signTransaction:f.signTransaction,
      approveReview:async op=>{seen.push(op.review.messageSha256);assert.deepEqual(f.calls,['quote']);return approve},
      sleep:async()=>{},loadTransaction:async()=>VersionedTransaction})
    if(approve)assert.equal((await task).status,'finalized-success')
    else{await assert.rejects(task,/consent/);assert.deepEqual(f.calls,['quote'])}
    assert.equal(seen.length,1)
  }
})

test('unfinished operations are remembered per wallet until forgotten', () => {
  const memory = new Map(), storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) }
  rememberOperation(storage, { wallet: 'A', signingId: '1', kind: 'buy' }); rememberOperation(storage, { wallet: 'B', signingId: '2', kind: 'fund' })
  assert.deepEqual(pendingOperations(storage, 'A').map(x => x.signingId), ['1'])
  forgetOperation(storage, '1'); assert.deepEqual(pendingOperations(storage, 'A'), [])
  assert.deepEqual(pendingOperations({ getItem: () => { throw Error('blocked') } }, 'A'), [], 'storage errors read as empty')
})

test('the largest buy under the max per wallet is found exactly, and is null once the wallet is full', () => {
  const max = maxBuyLamports(market)
  assert.ok(!estimateTrade(market, { side: 'buy', amount: max }).error); assert.match(estimateTrade(market, { side: 'buy', amount: max + 2000n }).error, /max per wallet/)
  assert.equal(maxBuyLamports(market, 20_000_000_000_000n), null, 'already at the cap')
  assert.ok(maxBuyLamports(market, 10_000_000_000_000n) < max, 'holding some lowers it')
})

test('the panel’s swap request passes the trade API’s exact schema (a rejected request after Add SOL would strand it)', async () => {
  const owner = '11111111111111111111111111111111', signingId = '11111111-1111-4111-8111-111111111111', seen = []
  const full = { ...market, mint: '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn', selectedConfig: '5hvm6s9DCiYX5QQFDVkcTKs1sF3PCKnACxYLHHTJCKZr' }
  const handler = createInclusiveTradeHandler({ env: { HOOK_INCLUSIVE_TRADING_ENABLED: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_TRADING_PUBLIC: 'true' },
    configuration: () => ({ origin: 'https://repo.ing' }), database: () => ({ end: async () => {} }), quota: async () => true, principalStore: () => ({ resolve: async () => ({ wallet: owner }) }),
    runtime: () => ({ origin: 'https://repo.ing', lifecycle: { createReview: async (t, i, value) => { seen.push(value); return { id: signingId, owner, stage: value.stage, status: 'reviewed', review: {} } } } }) })
  for (const side of ['buy', 'sell']) {
    const response = await handler(new Request('https://repo.ing/api/hook-lab/inclusive-trade', { method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'application/json',
      cookie: `__Host-hook-wallet-session=${Buffer.alloc(32, 9).toString('base64url')}` }, body: JSON.stringify({ action: 'quote', signingId, request: tradeIntent(full, side, 10_000_000n, 9_000_000n) }) }))
    assert.equal(response.status, 200, side)
  }
  assert.deepEqual(seen.map(x => x.stage), ['inclusive-buy', 'inclusive-sell'])
})

test('native HTTP accepts selected identity with zero gate cap, never a hybrid policy',async()=>{
  const owner=Keypair.generate().publicKey.toBase58(),signingId='11111111-1111-4111-8111-111111111111',seen=[]
  const handler=createInclusiveTradeHandler({env:{HOOK_INCLUSIVE_TRADING_ENABLED:'true',HOOK_WALLET_IDENTITY_ENABLED:'true',HOOK_TRADING_PUBLIC:'true',HOOK_NATIVE_TRADING_ENABLED:'true'},
    configuration:()=>({origin:'https://repo.ing'}),database:()=>({end:async()=>{}}),quota:async()=>true,moderation:async()=>({delisted:false}),
    principalStore:()=>({resolve:async()=>({wallet:owner})}),runtime:()=>({origin:'https://repo.ing',nativeTrading:true,lifecycle:{createReview:async(t,id,value)=>{
      seen.push(value);return {id:signingId,owner,stage:value.stage,status:'reviewed',review:{}}}}})})
  const selected={...market,mint:owner,selectedConfig:Keypair.generate().publicKey.toBase58(),policyKind:'selected-hook',capBps:0,
    selectedHook:{program:Keypair.generate().publicKey.toBase58(),flags:3}}
  const post=request=>handler(new Request('https://repo.ing/api/hook-lab/inclusive-trade',{method:'POST',headers:{origin:'https://repo.ing','content-type':'application/json',
    cookie:`__Host-hook-wallet-session=${Buffer.alloc(32,9).toString('base64url')}`},body:JSON.stringify({action:'native-quote',signingId,request})}))
  for(const side of ['buy','sell'])assert.equal((await post(nativeTradeIntent(selected,side,10_000n,1n,false))).status,200)
  assert.equal((await post({...nativeTradeIntent(selected,'buy',10_000n,1n,false),capBps:200})).status,400)
  assert.deepEqual(seen.map(x=>x.stage),['native-buy','native-sell'])
  assert.deepEqual(seen[0].intent.selectedHook,selected.selectedHook)
})

test('buys that would be refused are caught before any SOL moves: impact over 10%, past the end of the curve, max per wallet', () => {
  assert.match(estimateTrade({ ...market, capBps: 9000 }, { side: 'buy', amount: 400_000_000n }).error, /more than 10%/)
  // The swap does not refuse a buy that reaches graduation; the website stops it at exactly the final fill.
  const small = { ...market, capBps: 9000, graduationQuote: '20000000' }, fill = maxBuyLamports(small)
  assert.match(estimateTrade(small, { side: 'buy', amount: 30_000_000n }).error, /more than this coin’s curve has left: 0\.020202 SOL buys all of it/)
  assert.equal(estimateTrade(small, { side: 'buy', amount: fill }).graduates, true)
  assert.ok(!estimateTrade({ ...market, graduationQuote: '2000000000' }, { side: 'buy', amount: 10_000_000n }).error)
})

test('a sell from a wallet without a bridged-SOL holding creates it first, then sells and withdraws', () => {
  assert.deepEqual(planSell({ amount: 5n, wallet: { lamports: '10000000', bridgedSol: null }, rentLamports: '1686560' }).steps.map(s => s.kind), ['fund', 'sell', 'withdraw'])
  assert.deepEqual(planSell({ amount: 5n, wallet: { lamports: '10000000', bridgedSol: '0' } }).steps.map(s => s.kind), ['sell', 'withdraw'])
  assert.ok(planSell({ amount: 5n, wallet: { lamports: '100', bridgedSol: '0' } }).shortfall > 0n)
})

test('the trade button always offers the next step: connect, then sign in (no amount needed), then trade', () => {
  const base = { wallet: null, signedIn: false, side: 'buy', symbol: '$HLCANARY', hasAmount: false, blocked: false, tradingOpen: false, busy: false }
  assert.deepEqual(tradeButton(base), { label: 'Connect wallet', action: 'connect', disabled: false }, 'a new visitor can always connect, even before trading opens')
  assert.deepEqual(tradeButton({ ...base, hasMarket: false }), { label: 'Connect wallet', action: 'connect', disabled: false }, 'and while coin data is loading')
  const connected = { ...base, wallet: 'Fgze', tradingOpen: true }
  assert.deepEqual(tradeButton(connected), { label: 'Sign in with your wallet', action: 'sign-in', disabled: false }, 'signing in needs no amount')
  assert.deepEqual(tradeButton({ ...connected, hasAmount: true }), { label: 'Sign in and buy $HLCANARY', action: 'trade', disabled: false })
  assert.deepEqual(tradeButton({ ...connected, hasAmount: true, blocked: true }), { label: 'Sign in with your wallet', action: 'sign-in', disabled: false }, 'an amount that cannot trade still lets you sign in')
  const ready = { ...connected, signedIn: true }
  assert.deepEqual(tradeButton(ready), { label: 'Buy $HLCANARY', action: 'trade', disabled: true }, 'signed in: waits for an amount')
  assert.deepEqual(tradeButton({ ...ready, hasAmount: true, side: 'sell' }), { label: 'Sell $HLCANARY', action: 'trade', disabled: false })
  assert.equal(tradeButton({ ...ready, hasAmount: true, blocked: true }).disabled, true, 'an amount the swap would refuse')
  assert.equal(tradeButton({ ...ready, hasAmount: true, tradingOpen: false }).disabled, true, 'trading not open for this wallet yet')
  assert.deepEqual(tradeButton({ ...ready, hasAmount: true, busy: true }), { label: 'Working…', action: 'trade', disabled: true })
})
