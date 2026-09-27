import test from 'node:test'
import assert from 'node:assert/strict'
import { reserveMovePlan, reserveAlertText, createReserveWebhookSender, RESERVE_MOVE_COOLDOWN_MS } from '../src/reserve-alerts.mjs'

const now = Date.now()
const market = { githubRepoId: '998200', mint: 'mint', pool: 'curve', fullName: 'local/reserve' }
const state = (reserve, offset = 0, extra = {}) => ({ repoId: '998200', mint: 'mint', curve: 'curve', config: 'config',
  phase: 'CURVE', reserveLamports: String(reserve), thresholdLamports: '85000000000',
  checkedAt: new Date(now + offset).toISOString(), chainTime: new Date(now + offset).toISOString(), slots: [100 + offset, 101 + offset], ...extra })
const plan = (current, previous, offset = 0) => reserveMovePlan({ market, state: current, previous, now: now + offset })
const checkpoint = current => ({ ...current, reserveAlert: plan(current).baseline })

test('quiet initial baseline; small finalized changes accumulate into one exact positive alert', () => {
  const first = checkpoint(state(100000000))
  assert.equal(plan(state(100000000)).alert, null)
  assert.equal(plan(state(149999999, 1), first, 1).alert, null)
  const next = plan(state(150000000, 2), first, 2)
  assert.equal(next.alert.detail.deltaLamports, '50000000')
  assert.equal(next.alert.detail.previousReserveLamports, '100000000')
  assert.equal(next.alert.detail.progressPercent, 0.17)
  assert.match(reserveAlertText(1, next.alert.detail), /0.1 SOL → 0.15 SOL/)
  assert.match(reserveAlertText(1, next.alert.detail), /\+0.05 SOL/)
})
test('five-minute cooldown retains the last notified baseline; downward moves also notify', () => {
  const first = checkpoint(state(100000000)), current = state(160000000, 1)
  const emitted = plan(current, first, 1), previous = { ...current, reserveAlert: emitted.baseline }
  const during = plan(state(210000000, 30000), previous, 30000)
  assert.equal(during.alert, null); assert.equal(during.baseline.reserveLamports, '160000000')
  const after = RESERVE_MOVE_COOLDOWN_MS + 1
  const fall = plan(state(100000000, after), previous, after)
  assert.equal(fall.alert.detail.deltaLamports, '-60000000')
  assert.match(reserveAlertText(2, fall.alert.detail), /reserve down/)
})
test('replayed observations, unchanged reserves and canceled net moves never produce activity', () => {
  const first = checkpoint(state(100000000))
  assert.equal(plan(state(100000000), first).alert, null)
  const next = plan(state(150000000, 1), first, 1)
  assert.equal(plan(state(150000000, 1), { ...state(150000000, 1), reserveAlert: next.baseline }, 1).alert, null)
  assert.equal(plan(state(100000000, 2), first, 2).alert, null)
})
test('stale observations, wrong canonical identities/config/pool and slot regression fail closed', () => {
  const first = checkpoint(state(100000000))
  assert.throws(() => plan(state(150000000), first, 121000), /STALE_PROGRESS/)
  for (const extra of [{ repoId: 'other' }, { mint: 'wrong' }, { curve: 'wrong' }, { config: 'wrong' }, { thresholdLamports: '1' }, { slots: [99, 100] }])
    assert.throws(() => plan(state(150000000, 1, extra), first, 1))
})
test('verified migration starts a quiet DAMM baseline; LP changes are not called trading volume', () => {
  const first = checkpoint(state(85000000000))
  const graduated = state(0, 1, { phase: 'GRADUATED', dammSolLamports: '83000000000', destination: { pool: 'damm' }, migration: { pool: 'damm' } })
  const migration = plan(graduated, first, 1)
  assert.equal(migration.alert, null); assert.equal(migration.baseline.reserveLamports, '83000000000')
  const move = plan({ ...graduated, dammSolLamports: '83100000000', slots: [103, 104] }, { ...graduated, reserveAlert: migration.baseline }, 2)
  assert.equal(move.alert.detail.progressPercent, 100)
  assert.match(reserveAlertText(3, move.alert.detail), /DAMM SOL reserve up/)
  assert.doesNotMatch(reserveAlertText(3, move.alert.detail), /volume/)
  assert.throws(() => plan({ ...graduated, destination: { pool: 'wrong' } }, first, 1), /POOL_MISMATCH/)
})
test('webhook is disabled without a destination, bounded, no redirects, and contains only public movement evidence', async () => {
  assert.equal(createReserveWebhookSender({ env: {} }), null)
  for(const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/#secret'])
    assert.throws(()=>createReserveWebhookSender({env:{RESERVE_ALERT_WEBHOOK_URL:url}}),/ALERT_DESTINATION_INVALID/)
  const detail=plan(state(150000000,1),checkpoint(state(100000000)),1).alert.detail
  const sender=createReserveWebhookSender({env:{RESERVE_ALERT_WEBHOOK_URL:'https://example.com/private-webhook'},fetchImpl:async(url,options)=>{
    assert.equal(options.redirect,'error');assert.equal(options.method,'POST');assert.ok(options.signal)
    const body=JSON.parse(options.body);assert.equal(body.market.delivery,undefined);assert.equal(body.market.deltaLamports,'50000000')
    assert.equal(options.headers['Idempotency-Key'],'repoing-reserve-7')
    return {ok:true}
  }})
  assert.deepEqual(await sender({id:7,text:reserveAlertText(7,detail),detail}),{accepted:true})
  const failed=createReserveWebhookSender({env:{RESERVE_ALERT_WEBHOOK_URL:'https://example.com/hook'},fetchImpl:async()=>({ok:false})})
  await assert.rejects(failed({id:7,text:'test',detail}),/NOTIFICATION_SEND_FAILED/)
})
