// Offline validation only. Inputs must be actual SBF exports; never creates VM state or receipts.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import {BorshCoder} from '@anchor-lang/core'
import {deriveInclusiveTradePostconditions,verifyInclusiveTradeExecution} from '../src/hooklab-inclusive-trade-settlement.mjs'
import { buildInclusiveMaxWalletSwapReviewForFixture } from '../src/hooklab-inclusive-max-wallet-swap.mjs'
import { inclusiveMaxWalletSwapFixtureFromVmState } from '../tests/fixtures/hooklab-inclusive-max-wallet-swap.mjs'
const root = process.env.HOOKLAB_INCLUSIVE_VECTOR_DIR
if (!root || !isAbsolute(root)) throw Error('HOOKLAB_INCLUSIVE_VECTOR_DIR must point to actual generated SBF vectors')
const read = name => readFileSync(new URL(`../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/${name}`, import.meta.url))
const manifest = JSON.parse(read('build-artifacts.json')), json = read('offline-builder-profile.json').toString()
assert.equal(createHash('sha256').update(json).digest('hex'), manifest.profileSha256)
const names = { launch: 'bordrless_launch', swap: 'bordrless_swap', gate: 'hook_max_wallet' }
const profile = { json, expectedSha256: manifest.profileSha256, providers: ['fixture-a', 'fixture-b'],
  idls: Object.fromEntries(Object.entries(names).map(([role, name]) => [role, read(`${name}.json`).toString('base64')])),
  elfLengths: Object.fromEntries(Object.entries(manifest.artifacts).map(([role, artifact]) => [role, artifact.elfLength])) }
const ledger=JSON.parse(readFileSync(resolve(root,'ledger.json')))
const swapCoder=new BorshCoder(JSON.parse(Buffer.from(profile.idls.swap,'base64')))
const tokenCoder=new BorshCoder(JSON.parse(readFileSync(new URL('../vendor/hooklab-production-candidate/idl/bordrless_token.json',import.meta.url))))
let buyCompilation
for (const side of ['buy', 'sell']) {
  const state = JSON.parse(readFileSync(resolve(root, `inclusive-${side}-rust-vector.json`))), r = state.request
  const request = { schema: 'repoing/inclusive-max-wallet-swap-request/1', policyKind: 'max-wallet', policyVersion: 2,
    creatorFeeBps: r.creatorFeeBps, feeModel: r.feeModel, protocolShareBps: r.protocolShareBps, capBps: r.capBps,
    side, trader: r.creator, recipient: r.creator, feePayer: r.feePayer, mint: r.mint, selectedConfig: r.selectedConfig,
    amountIn: state.quote.amountIn, minAmountOut: state.quote.minAmountOut, maxInput: state.quote.amountIn, maxPriceImpactBps: 1000 }
  const fixture = inclusiveMaxWalletSwapFixtureFromVmState(state, profile, request)
  const plan = buildInclusiveMaxWalletSwapReviewForFixture(fixture), ix = state.quote.instruction
  if (side === 'buy') buyCompilation = {...fixture, provenance:'server-collected-finalized-state-not-execution-authorization'}
  else {
    const map = new Map(fixture.observations[0].accounts.map(x => [x.address,x.account]))
    const pool = new BorshCoder(JSON.parse(Buffer.from(profile.idls.swap,'base64'))).accounts.decode('Pool',Buffer.from(map.get(plan.addresses.pool).dataBase64,'base64'))
    const expected = deriveInclusiveTradePostconditions(buyCompilation,pool.last_swap_at.toString())
    for (const row of expected) { const actual=map.get(row.address);const stripped=actual?(({lamports,...rest})=>rest)(actual):null;assert.deepEqual(stripped,row.account) }
    console.log('Exact inclusive buy affected post-state matches actual next SBF snapshot')
  }

  const raw=ledger[side].rawEvents
  const decoded=raw.map(e=>(e.program===JSON.parse(json).programs.swap?swapCoder:tokenCoder).events.decode(Buffer.concat([Buffer.from(e.discriminatorHex,'hex'),Buffer.from(e.bodyBase64,'base64')]).toString('base64'))).filter(Boolean)
  const feeEvent=decoded.find(e=>e.name==='InclusiveCreatorFeeAccrued').data,swapEvent=decoded.find(e=>e.name==='Swapped').data
  const transfers=decoded.filter(e=>e.name==='Transferred').map(e=>e.data)
  const execution=verifyInclusiveTradeExecution({ci:fixture,plan,feeEvent,swapEvent,transfers,slot:Number(swapEvent.slot)})
  assert.equal(execution.quote.delivered,String(ledger[side].delivered))
  assert.equal(execution.quote.grossCreatorFee,String(ledger[side].grossCreatorFee))
  assert.equal(execution.tokenBalances.length,5)
  const advisoryPlan={...plan,request:{...plan.request,maxPriceImpactBps:0}}
  assert.equal(verifyInclusiveTradeExecution({ci:fixture,plan:advisoryPlan,feeEvent,swapEvent,transfers,slot:Number(swapEvent.slot)}).quote.priceImpactReviewBoundExceeded,true)
  console.log(`${side}: actual SBF token balance events reconstruct exact transaction-local execution`)
  assert.deepEqual(plan.canonicalInstruction, { program: ix.programId, dataHex: ix.dataHex,
    accounts: ix.keys.map(k => ({ address: k.pubkey, signer: k.isSigner, writable: k.isWritable })) })
  assert.equal(plan.quote.delivered, state.quote.delivered)
  assert.equal(plan.canonicalInstruction.accounts.length, 24)
  assert.deepEqual(plan.canonicalInstruction.accounts.at(-1), { address: plan.addresses.inclusiveFeePolicy, signer: false, writable: false })
  assert.equal(plan.canSign, false); assert.equal(plan.canSubmit, false)
  writeFileSync(resolve(root, `inclusive-${side}-app-plan.json`), JSON.stringify(plan, null, 2) + '\n')
  console.log(JSON.stringify({ side, status: 'actual-SBF-vector-matches-offline-app-plan', quote: plan.quote, messageSha256: plan.review.messageSha256 }))
}
