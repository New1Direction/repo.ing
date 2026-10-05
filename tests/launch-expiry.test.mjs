import test from 'node:test'
import assert from 'node:assert/strict'
import {assertExpiredUnlandedLaunch,createExpiredLaunchCheck,proveExpiredUnlandedLaunch,releaseExpiredLaunch} from '../src/launch-expiry.mjs'
const now=Date.now(), market={status:'ambiguous',mint:'mint',pool:'pool',launch_signature:'sig',blockhash:'hash',last_valid_block_height:'100'}
const observation={getGenesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',getBlockHeight:300,isBlockhashValid:{value:false,context:{slot:400}},getSignatureStatuses:{value:[null],context:{slot:400}},getTransaction:null,getMultipleAccounts:{value:[null,null],context:{slot:400}}}
const evidence=()=>({independentRpc:true,checkedAt:new Date(now).toISOString(),observations:[structuredClone(observation),structuredClone(observation)]})
test('two fresh mainnet providers prove an expired launch never landed',()=>assert.equal(assertExpiredUnlandedLaunch(market,evidence(),now).status,'EXPIRED_UNLANDED'))
test('never release landed, unexpired, stale, single-provider or disputed evidence',()=>{
 for(const mutate of [e=>e.independentRpc=false,e=>e.checkedAt=new Date(now-61000).toISOString(),e=>e.observations[1].getTransaction={},e=>e.observations[1].getMultipleAccounts.value[0]={},e=>e.observations[1].getSignatureStatuses.value[0]={err:null},e=>e.observations[1].getBlockHeight=249,e=>e.observations[1].isBlockhashValid.value=true,e=>e.observations[1].getGenesisHash='devnet',e=>e.observations[1].getMultipleAccounts.context.slot=700]){
  const e=evidence();mutate(e);assert.throws(()=>assertExpiredUnlandedLaunch(market,e,now))
 }
 for(const change of [{status:'confirmed'},{indexed_at:new Date()},{launch_slot:'1'},{launch_signature:null}])assert.throws(()=>assertExpiredUnlandedLaunch({...market,...change},evidence(),now))
})

// One provider as the proof reads it (observeLaunchExpiry): the same answers as `observation` above, unless overridden.
const provider = (overrides = {}) => {
  const calls = []
  const answer = (name, value) => async (...args) => { calls.push(name); return name in overrides ? overrides[name] : value }
  return { calls, getGenesisHash: answer('getGenesisHash', observation.getGenesisHash), getBlockHeight: answer('getBlockHeight', 300),
    isBlockhashValid: answer('isBlockhashValid', { value: false, context: { slot: 400 } }),
    getSignatureStatuses: answer('getSignatureStatuses', { value: [null], context: { slot: 400 } }), getTransaction: answer('getTransaction', null),
    getMultipleAccountsInfoAndContext: answer('getMultipleAccountsInfoAndContext', { value: [null, null], context: { slot: 400 } }) }
}
const row = { id: 7, github_repo_id: '123', status: 'ambiguous', mint: '11111111111111111111111111111111', pool: 'SysvarRent111111111111111111111111111111111',
  launch_signature: 'sig', blockhash: 'hash', last_valid_block_height: '100', launch_slot: null, indexed_at: null }

test('the shared proof reads both providers and holds only when both show the attempt expired and unlanded', async () => {
  const proven = await proveExpiredUnlandedLaunch([provider(), provider()], row, () => now)
  assert.equal(proven.proof.status, 'EXPIRED_UNLANDED')
  assert.equal(proven.evidence.observations.length, 2)
  assert.deepEqual(proven.evidence.observations[0].getMultipleAccounts.value, [null, null])
  await assert.rejects(() => proveExpiredUnlandedLaunch([provider(), provider({ getTransaction: { slot: 1 } })], row, () => now), /NOT_PROVEN/)
  await assert.rejects(() => proveExpiredUnlandedLaunch([provider(), provider({ getMultipleAccountsInfoAndContext: { value: [null, { owner: 'x' }], context: { slot: 400 } } })], row, () => now), /NOT_PROVEN/)
  await assert.rejects(() => proveExpiredUnlandedLaunch([provider()], row, () => now), /RPC_REQUIRED/)
})

test('the worker check waits cheaply until the margin has passed, then proves; any failure is null', async () => {
  const early = provider({ getBlockHeight: 250 })
  assert.equal(await createExpiredLaunchCheck({ connections: [early, provider()], now: () => now })(row), null)
  assert.deepEqual(early.calls, ['getBlockHeight'])
  assert.equal((await createExpiredLaunchCheck({ connections: [provider(), provider()], now: () => now })(row)).proof.status, 'EXPIRED_UNLANDED')
  const unreachable = { ...provider(), getGenesisHash: async () => { throw Error('fetch failed') } }
  assert.equal(await createExpiredLaunchCheck({ connections: [provider(), unreachable], now: () => now })(row), null)
  assert.equal(await createExpiredLaunchCheck({ connections: [provider(), provider({ getSignatureStatuses: { value: [{ err: null }], context: { slot: 400 } } })], now: () => now })(row), null)
})

test('a release records the alert and fails the attempt in one transaction, only while it is still that attempt', async () => {
  const client = rowCount => {
    const queries = []
    return { queries, query: async (sql, args) => { queries.push([sql.split(/\s+/).slice(0, 3).join(' '), args]); return { rowCount: /^update/.test(sql) ? rowCount : 0 } } }
  }
  const proven = await proveExpiredUnlandedLaunch([provider(), provider()], row, () => now)
  const ok = client(1)
  await releaseExpiredLaunch(ok, row, proven, 'worker')
  assert.deepEqual(ok.queries.map(([sql]) => sql), ['begin', 'insert into graduation_alerts(event_key,github_repo_id,kind,detail)', 'update markets set', 'commit'])
  assert.deepEqual(ok.queries[1][1].slice(0, 2), ['launch-expired:sig', '123'])
  assert.equal(JSON.parse(ok.queries[1][1][2]).reviewedBy, 'worker')
  assert.deepEqual(ok.queries[2][1], [7, 'ambiguous', 'sig'])
  const changed = client(0)
  await assert.rejects(() => releaseExpiredLaunch(changed, row, proven, 'worker'), /changed during review/)
  assert.equal(changed.queries.at(-1)[0], 'rollback')
})
