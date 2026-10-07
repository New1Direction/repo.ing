import test from 'node:test'
import assert from 'node:assert/strict'
import { reserveMovePlan, reserveAlertText, createReserveWebhookSender, pendingDelivery, feeLedgerAlertDetail, marketPassAlertDetail, platformLedgerAlertDetail, RESERVE_MOVE_COOLDOWN_MS, ledgerChecksAlertDetail,
  testAlertMessage } from '../src/reserve-alerts.mjs'
import { digestDelivery } from '../src/ledger-digest.mjs'

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
test('Slack, Discord and Telegram each get the message in their own shape; any other receiver gets the event', async () => {
  const detail = { role: 'Builder payout signer', minimumLamports: '30000000', balanceLamports: '1000', observedAt: '2026-10-05T08:15:00.000Z', delivery: pendingDelivery(0) }
  const text = reserveAlertText(9, detail)
  const sent = async destination => {
    const requests = []
    const sender = createReserveWebhookSender({ env: { RESERVE_ALERT_WEBHOOK_URL: destination }, fetchImpl: async (url, options) => { requests.push([String(url), JSON.parse(options.body), options]); return { ok: true } } })
    assert.deepEqual(await sender({ id: 9, text, detail }), { accepted: true })
    assert.equal(requests.length, 1)
    assert.equal(requests[0][2].redirect, 'error'); assert.equal(requests[0][2].method, 'POST'); assert.equal(requests[0][2].headers['Content-Type'], 'application/json')
    return requests[0].slice(0, 2)
  }
  assert.deepEqual(await sent('https://hooks.slack.com/services/T0/B0/secret'), ['https://hooks.slack.com/services/T0/B0/secret', { text }])
  for (const host of ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'])
    assert.deepEqual(await sent(`https://${host}/api/webhooks/123/secret`), [`https://${host}/api/webhooks/123/secret`, { content: text, allowed_mentions: { parse: [] } }])
  // A host that only ends in the same letters is not Discord.
  assert.equal((await sent('https://notdiscord.com/api/webhooks/123/secret'))[1].event, 'operating_wallet_low')
  // Telegram: the chat is named in the destination's own query, and the request goes to the method itself.
  assert.deepEqual(await sent('https://api.telegram.org/bot123:secret/sendMessage?chat_id=-1001234567890'),
    ['https://api.telegram.org/bot123:secret/sendMessage', { chat_id: '-1001234567890', text, link_preview_options: { is_disabled: true } }])
  assert.deepEqual(await sent('https://api.telegram.org/bot123:secret/sendMessage?chat_id=@repoing_ops'),
    ['https://api.telegram.org/bot123:secret/sendMessage', { chat_id: '@repoing_ops', text, link_preview_options: { is_disabled: true } }])
  const [, generic] = await sent('https://example.com/hook')
  assert.deepEqual([generic.event, generic.id, generic.text, generic.market.role, generic.market.delivery], ['operating_wallet_low', 9, text, 'Builder payout signer', undefined])
  // The test message of scripts/send-test-alert.mjs is its own event, and each one has an id of its own: a receiver that
  // drops a repeated id still shows a second test.
  const sentAt = Date.parse('2026-10-05T08:15:00.000Z'), headers = []
  let tested
  const testSender = createReserveWebhookSender({ env: { RESERVE_ALERT_WEBHOOK_URL: 'https://example.com/hook' }, fetchImpl: async (_url, options) => { tested = JSON.parse(options.body); headers.push(options.headers['Idempotency-Key']); return { ok: true } } })
  await testSender(testAlertMessage(sentAt))
  assert.deepEqual([tested.event, tested.id, tested.text], ['test', `test-${sentAt}`, 'repo.ing · Test alert\nOperator alerts will arrive here.\nSent: 2026-10-05T08:15:00.000Z'])
  await testSender(testAlertMessage(sentAt + 1000))
  assert.deepEqual(headers, [`repoing-reserve-test-${sentAt}`, `repoing-reserve-test-${sentAt + 1000}`])
  assert.match(testAlertMessage().id, /^test-\d{13}$/)
  // A message longer than the receiver takes is cut, not refused.
  const long = 'x'.repeat(5000), cut = async destination => {
    let body
    await createReserveWebhookSender({ env: { RESERVE_ALERT_WEBHOOK_URL: destination }, fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true } } })({ id: 1, text: long, detail })
    return body
  }
  assert.equal((await cut('https://discord.com/api/webhooks/123/secret')).content.length, 2000)
  assert.equal((await cut('https://api.telegram.org/bot123:secret/sendMessage?chat_id=5')).text.length, 4096)
})

test('a Telegram or Discord destination that cannot work is refused when the worker starts, not at the first alert', () => {
  for (const url of ['https://api.telegram.org/bot123:secret/sendMessage', 'https://api.telegram.org/bot123:secret/sendMessage?chat_id=', 'https://api.telegram.org/bot123:secret/getUpdates?chat_id=5',
    'https://api.telegram.org/sendMessage?chat_id=5', 'https://discord.com/channels/1/2', 'https://discord.com/api/webhooks/'])
    assert.throws(() => createReserveWebhookSender({ env: { RESERVE_ALERT_WEBHOOK_URL: url } }), /ALERT_DESTINATION_INVALID/, url)
  // The error never carries the destination.
  try { createReserveWebhookSender({ env: { RESERVE_ALERT_WEBHOOK_URL: 'https://api.telegram.org/bot123:secret/sendMessage' } }) } catch (error) { assert.doesNotMatch(String(error.message), /secret|telegram/) }
})

test('a reserve move is recorded without a notification unless reserve notifications are on', () => {
  const first = checkpoint(state(100000000))
  assert.deepEqual(plan(state(150000000, 1), first, 1).alert.detail.delivery, { status: 'off' })
  const notified = reserveMovePlan({ market, state: state(150000000, 1), previous: first, now: now + 1, notify: true })
  assert.deepEqual(notified.alert.detail.delivery, pendingDelivery(now + 1))
  assert.deepEqual(pendingDelivery(0), { status: 'pending', attempts: 0, nextAttemptAt: '1970-01-01T00:00:00.000Z' })
})
test('a ledger alert names the ledger, says whether it is lag or a real mismatch, and since when', async () => {
  const since = '2026-10-05T08:00:00.000Z', observedAt = '2026-10-05T08:15:00.000Z', url = 'https://repo.ing/token/mint'
  const tail = `Since: ${since}\nChecked: ${observedAt}\n${url}`
  const market = { ledger: 'fees', fullName: 'local/reserve', since, observedAt, url }
  const behind = reserveAlertText(11, { ...market, status: 'MISMATCH', reason: null, lagging: true, stalled: true })
  assert.equal(behind, `repo.ing · Fee ledger behind the chain\nlocal/reserve\nThe chain shows fees the worker has not recorded, and nothing new was recorded for an hour. The fee indexer may be stuck or may have missed a trade.\n${tail}\nAlert #11`)
  // Behind for six hours while fees are still being recorded is worded as what it is.
  assert.equal(reserveAlertText(11, { ...market, status: 'MISMATCH', reason: null, lagging: true, stalled: false }),
    `repo.ing · Fee ledger behind the chain\nlocal/reserve\nThe chain has shown fees the worker has not recorded for six hours without a break, though fees are still being recorded. The fee indexer may be falling behind.\n${tail}\nAlert #11`)
  // Only a row that says its ledger still records is worded so.
  assert.equal(reserveAlertText(11, { ...market, status: 'MISMATCH', reason: null, lagging: true }), behind)
  assert.match(reserveAlertText(12, { ...market, status: 'UNAVAILABLE', reason: null, lagging: true }), /Fee ledger could not be checked\nlocal\/reserve\nThe on-chain read keeps failing\./)
  assert.match(reserveAlertText(13, { ...market, status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)', lagging: true }), /Builder claim still unresolved\nlocal\/reserve\n1 unresolved claim intent/)
  const real = reserveAlertText(14, { ...market, status: 'MISMATCH', reason: 'Graduated fee withdrawals differ from proven payouts', lagging: false })
  assert.match(real, /Fee ledger does not match the chain\nlocal\/reserve\nGraduated fee withdrawals differ from proven payouts/)
  assert.match(reserveAlertText(15, { ...market, status: 'MISMATCH', reason: null, lagging: false, difference: '-12' }), /The ledger shows more fees than the chain holds\./)
  assert.match(reserveAlertText(15, { ...market, status: 'MISMATCH', reason: null, lagging: false, difference: null }), /Fee ledger does not match the chain\nlocal\/reserve\nThe ledger and the chain disagree\./)
  // A pool the chain does not have is a finding of the read, said in the reconciler's own words.
  assert.match(reserveAlertText(15, { ...market, status: 'UNAVAILABLE', reason: 'Canonical Meteora pool state is missing', lagging: false }), /Fee ledger does not match the chain\nlocal\/reserve\nCanonical Meteora pool state is missing\n/)
  const platform = reserveAlertText(16, { ledger: 'platform', revenue: 'MISMATCH', liquidity: 'MATCH', problems: ['Allocations exceed claimed platform revenue'], since, observedAt })
  assert.match(platform, /^repo\.ing · Platform ledger does not match\nRevenue: MISMATCH · Liquidity: MATCH\nAllocations exceed claimed platform revenue\nSince: /)
  // A market whose pass keeps ending in review: which market, the review code, and what it means for the site.
  const episode = { kind: 'unchecked', repeat: false, since }, at = Date.parse(observedAt), listed = { mint: 'mint', fullName: 'local/reserve' }
  assert.equal(reserveAlertText(20, marketPassAlertDetail({ market: listed, code: 'RPC_UNAVAILABLE', transient: true, episode, now: at })),
    `repo.ing · Market could not be verified\nlocal/reserve\nThe monitor's reads for this market keep failing (RPC_UNAVAILABLE).\nIts public progress is not refreshed while this lasts.\n${tail}\nAlert #20`)
  assert.equal(reserveAlertText(21, marketPassAlertDetail({ market: listed, code: 'CONFIG_OR_POOL_MISMATCH', transient: false, episode, now: at })),
    `repo.ing · Market verification failed\nlocal/reserve\nThe monitor's pass for this market fails (CONFIG_OR_POOL_MISMATCH).\nIts public progress is not refreshed while this lasts.\n${tail}\nAlert #21`)
  // The monitor's pass not getting through its markets, and getting through them too slowly.
  const checks = reserveAlertText(18, ledgerChecksAlertDetail({ code: 'RPC_UNAVAILABLE', episode, now: at }))
  assert.equal(checks, `repo.ing · Ledger checks are not running\nThe monitor's pass stops before it has checked every market, so ledgers go unchecked (RPC_UNAVAILABLE).\nSince: ${since}\nChecked: ${observedAt}\nAlert #18`)
  assert.equal(reserveAlertText(22, ledgerChecksAlertDetail({ code: 'PASS_TOO_SLOW', episode, now: at })),
    `repo.ing · Ledger checks are too slow\nPasses over the markets come round less often than every five minutes, so public progress expires between passes.\nSince: ${since}\nChecked: ${observedAt}\nAlert #22`)
  // A code that is not one is never sent, for a pass or for a market.
  const leaky = 'fetch failed https://rpc.example/?api-key=secret'
  assert.doesNotMatch(reserveAlertText(19, ledgerChecksAlertDetail({ code: leaky, episode, now: 0 })), /secret|rpc\.example|\(/)
  assert.doesNotMatch(reserveAlertText(19, marketPassAlertDetail({ market: listed, code: leaky, transient: false, episode, now: 0 })), /secret|rpc\.example|\(/)
  // Sent as its own event, without delivery metadata.
  const events = []
  const sender = createReserveWebhookSender({ env: { RESERVE_ALERT_WEBHOOK_URL: 'https://example.com/hook' }, fetchImpl: async (_url, options) => { events.push(JSON.parse(options.body)); return { ok: true } } })
  await sender({ id: 11, text: behind, detail: { ...market, status: 'MISMATCH', lagging: true, delivery: pendingDelivery(0) } })
  assert.equal(events[0].event, 'reconciliation_mismatch'); assert.equal(events[0].market.delivery, undefined); assert.equal(events[0].market.fullName, 'local/reserve')
})
test('ledger alert details carry fixed wording, a place in the next ledger message and no provider text', () => {
  const episode = { key: 'episode:abc', lagging: true, kind: 'unchecked', repeat: false, since: '2026-10-05T08:00:00.000Z' }, at = Date.parse('2026-10-05T08:15:00.000Z')
  const market = { githubRepoId: '998200', mint: 'mint', pool: 'curve', fullName: 'local/reserve' }
  const failed = feeLedgerAlertDetail({ market, episode, observedAt: '2026-10-05T08:15:00.000Z', now: at,
    reconciliation: { status: 'UNAVAILABLE', reason: 'Meteora pool read failed: 401 https://rpc.example/?api-key=secret', difference: null } })
  // Only this codebase's own reasons are kept, whatever the status.
  for (const reason of ['Meteora pool read failed: timeout', 'connect ECONNREFUSED 10.0.0.5:5432', 'fetch failed https://rpc.example/?api-key=secret', ''])
    assert.equal(feeLedgerAlertDetail({ market, episode, observedAt: '', now: at, reconciliation: { status: 'MISMATCH', reason } }).reason, null)
  for (const reason of ['Partner fee capture differs from chain evidence', 'Canonical Meteora pool does not match the market', 'Canonical Meteora pool state is missing',
    '2 unresolved claim intent(s)', 'EVIDENCE_UNAVAILABLE'])
    assert.equal(feeLedgerAlertDetail({ market, episode, observedAt: '', now: at, reconciliation: { status: 'MISMATCH', reason } }).reason, reason)
  // What the episode says about the row goes with it: its kind, whether it is a repeat, and since when.
  const recorded = { kind: 'unchecked', repeat: false, since: episode.since, delivery: digestDelivery(at) }
  assert.deepEqual(failed, { ledger: 'fees', status: 'UNAVAILABLE', reason: null, lagging: true, stalled: false, difference: null, fullName: 'local/reserve',
    observedAt: '2026-10-05T08:15:00.000Z', url: 'https://repo.ing/token/mint', ...recorded })
  assert.doesNotMatch(reserveAlertText(1, failed), /secret|rpc\.example/)
  // None is queued to be sent by itself: the delivery job puts what was recorded into one message (src/ledger-digest.mjs).
  assert.deepEqual(digestDelivery(at), { status: 'digest', queuedAt: '2026-10-05T08:15:00.000Z' })
  assert.deepEqual(ledgerChecksAlertDetail({ code: 'RPC_RATE_LIMITED', episode, now: at }), { ledger: 'checks', reason: 'RPC_RATE_LIMITED', observedAt: '2026-10-05T08:15:00.000Z', ...recorded })
  assert.deepEqual(marketPassAlertDetail({ market, code: 'STALE_PROGRESS', transient: true, episode, now: at }), { ledger: 'market', status: 'UNAVAILABLE', reason: 'STALE_PROGRESS', lagging: true,
    fullName: 'local/reserve', observedAt: '2026-10-05T08:15:00.000Z', url: 'https://repo.ing/token/mint', ...recorded })
  assert.deepEqual(marketPassAlertDetail({ market, code: 'LP_SETTLEMENT_MISMATCH', transient: false, episode: { ...episode, repeat: true }, now: at }),
    { ledger: 'market', status: 'ERROR', reason: 'LP_SETTLEMENT_MISMATCH', lagging: false, fullName: 'local/reserve', observedAt: '2026-10-05T08:15:00.000Z', url: 'https://repo.ing/token/mint',
      ...recorded, repeat: true })
  const real = feeLedgerAlertDetail({ market, episode: { ...episode, lagging: false, kind: 'difference' }, observedAt: '2026-10-05T08:15:00.000Z', now: at,
    reconciliation: { status: 'MISMATCH', reason: 'Graduated fee withdrawals differ from proven payouts', difference: -12n } })
  assert.deepEqual([real.reason, real.difference, real.lagging, real.kind], ['Graduated fee withdrawals differ from proven payouts', '-12', false, 'difference'])
  const stuck = feeLedgerAlertDetail({ market, episode: { ...episode, kind: 'behind', stalled: true }, observedAt: '', now: at, reconciliation: { status: 'MISMATCH', difference: 5n } })
  assert.deepEqual([stuck.kind, stuck.stalled, stuck.difference], ['behind', true, '5'])
  assert.deepEqual(platformLedgerAlertDetail({ revenue: { status: 'MISMATCH', problems: ['Allocations exceed claimed platform revenue'] }, liquidity: { status: 'MATCH', problems: [] },
    episode: { ...episode, kind: 'difference' }, now: at }),
    { ledger: 'platform', revenue: 'MISMATCH', liquidity: 'MATCH', problems: ['Allocations exceed claimed platform revenue'], observedAt: '2026-10-05T08:15:00.000Z', ...recorded, kind: 'difference' })
})
test('a send that fails says why by a fixed code: the receiver\'s status, a timeout or the network, never its answer', async () => {
  const failure = fetchImpl => createReserveWebhookSender({ env: { RESERVE_ALERT_WEBHOOK_URL: 'https://example.com/hook' }, fetchImpl })({ id: 1, text: 'test', detail: { observedAt: '' } })
    .then(() => null, error => [error.message, error.code, Object.keys(error)])
  let cancelled = 0
  const answered = status => async () => ({ ok: false, status, body: { cancel: async () => { cancelled++ } } })
  assert.deepEqual(await failure(answered(404)), ['NOTIFICATION_SEND_FAILED', 'HTTP_404', ['code']])
  assert.deepEqual(await failure(answered(400)), ['NOTIFICATION_SEND_FAILED', 'HTTP_400', ['code']])
  assert.deepEqual(await failure(answered(503)), ['NOTIFICATION_SEND_FAILED', 'HTTP_503', ['code']])
  assert.equal(cancelled, 3, 'the answer is discarded unread')
  assert.deepEqual(await failure(async () => ({ ok: false })), ['NOTIFICATION_SEND_FAILED', 'HTTP_ERROR', ['code']])
  assert.deepEqual(await failure(async () => { throw Object.assign(Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }), ['NOTIFICATION_SEND_FAILED', 'TIMEOUT', ['code']])
  assert.deepEqual(await failure(async () => { throw TypeError('fetch failed: getaddrinfo ENOTFOUND hooks.example/secret-token') }), ['NOTIFICATION_SEND_FAILED', 'NETWORK', ['code']])
  assert.equal(await failure(async () => ({ ok: true, status: 200 })), null)
})

// Step 8 (docs/EARLY_ACCESS.md): a full curve still not migrated is delivered as its own message.
test('a full curve not migrated reads as its own alert message', () => {
  const text = reserveAlertText(7, { fullName: 'octo/second', curve: 'Curve1111', curveFinishedAt: '2026-10-07T08:00:00.000Z', minutes: 31,
    observedAt: '2026-10-07T08:31:00.000Z', delivery: { status: 'pending' } })
  assert.equal(text.split('\n')[0], 'repo.ing · Full curve not migrated')
  assert.match(text, /octo\/second\nThe curve filled at 2026-10-07T08:00:00.000Z and has not migrated after 31 minutes\./)
  assert.match(text, /Curve: Curve1111\nAlert #7$/)
})
