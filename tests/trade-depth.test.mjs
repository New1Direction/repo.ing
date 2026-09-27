import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateBuySizes } from '../src/trade-depth.mjs'
test('trade sizes remain inside the target impact and executable inventory',()=>{
  assert.deepEqual(estimateBuySizes(10000n,n=>Number(n)/100),[{percent:1,amountLamports:'100'},{percent:3,amountLamports:'300'}])
  assert.deepEqual(estimateBuySizes(10000n,n=>{if(n>150n)throw Error('Complete');return Number(n)/100}),[{percent:1,amountLamports:'100'},{percent:3,amountLamports:'150'}])
  assert.ok(estimateBuySizes(100n,()=>{throw Error('Unavailable')}).every(x=>x.amountLamports==='0'))
})
