import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE_SCHEMA, RESULT_SCHEMA, REVIEW_SCHEMA, MAX_RESPONSE_BYTES, createFlow, receiveState, validateInput, rawAmount, beginRequest, receiveReview, receiveResult, receiveRejection, invalidate, cancelReview, unknown, parseState, parseResult, readBoundedJson } from './max-wallet-flow-state.mjs';
const key = '11111111111111111111111111111111';
const hash = 'a'.repeat(64), otherHash = 'b'.repeat(64);
let sequence = 1;
const uuid = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
const state = (overrides = {}) => ({ schema: STATE_SCHEMA, mode: 'synthetic-sbf', sessionId: 'test-session', revision: 0, phase: 'unprepared', policy: { capBps: null, rawCap: null, initialSupply: '1000000000000000' }, identities: { creator: key, mint: key, selectedConfig: key, trader: key }, balances: { traderBaseRaw: '0', traderQuoteRaw: '100000000' }, supportedActions: ['prepare'], canSign: false, canSubmit: false, productionPreparationReceiptAccepted: false, profileSha256: hash, notice: 'Synthetic SBF test. Signatures not verified.', ...overrides });
const preparedState = (overrides = {}) => state({ revision: 1, phase: 'prepared', policy: { capBps: 100, rawCap: '10000000000000', initialSupply: '1000000000000000' }, supportedActions: ['launch'], ...overrides });
const launchedState = (overrides = {}) => preparedState({ revision: 2, phase: 'launched', supportedActions: ['quote', 'buy', 'sell', 'pause'], ...overrides });
const ready = (value = state()) => receiveState(createFlow(), value);
const prep = { capBps: 100, label: 'Explicit test' };
const launch = { name: 'Local test', symbol: 'TST', uri: '', virtualQuote: '1000000000' };
const trade = { direction: 'buy', amountInRaw: '100', minAmountOutRaw: '1' };
function review(flow, action, input) {
  const request = beginRequest(flow, 'review', action, input, uuid(), 1000);
  const response = { schema: REVIEW_SCHEMA, requestId: request.envelope.requestId, reviewId: uuid(), action, revision: flow.server.revision, sessionId: flow.server.sessionId, profileSha256: hash, messageSha256: hash, wireBytes: 900, requiredSigners: [key], expiresAtMs: 100000, canSign: false, canSubmit: false };
  return { flow: receiveReview(request.flow, response, 1000), request, response };
}
function result(request, nextState, options = {}) {
  return { schema: RESULT_SCHEMA, requestId: request.envelope.requestId, action: request.envelope.action, outcome: 'succeeded', messageSha256: hash, state: nextState, canSign: false, canSubmit: false, ...options };
}
function quoted(flow = ready(launchedState()), input = trade) {
  const request = beginRequest(flow, 'quote', 'quote', { ...input, minAmountOutRaw: '0' }, uuid());
  return receiveResult(request.flow, result(request, flow.server, { outcome: 'quoted', messageSha256: null, quote: { direction: input.direction, amountInRaw: input.amountInRaw, amountOutRaw: '500' } }));
}

test('forms start without policy defaults; canonical raw input and exact fields only', () => {
  assert.equal(createFlow().server, null); assert.equal(createFlow().review, null); assert.equal(createFlow().quote, null);
  for (const value of ['', '01', '-1', '1.1', '1e5', ' 1', '18446744073709551616', 1]) assert.throws(() => rawAmount(value));
  assert.equal(rawAmount('18446744073709551615'), '18446744073709551615');
  assert.equal(rawAmount('0'), '0'); assert.throws(() => rawAmount('0', true));
  for (const capBps of [null, 0, 10000, 1.1, '100']) assert.throws(() => validateInput('prepare', { ...prep, capBps }));
  assert.throws(() => validateInput('prepare', { ...prep, simulation: {} }));
  assert.throws(() => validateInput('prepare', { ...prep, label: '🙂'.repeat(9) }));
  assert.doesNotThrow(() => validateInput('launch', { ...launch, symbol: 'é' }));
  assert.throws(() => validateInput('buy', { ...trade, minAmountOutRaw: '' }));
  assert.throws(() => validateInput('buy', { ...trade, minAmountOutRaw: '0' }));
  assert.throws(() => validateInput('quote', { ...trade, minAmountOutRaw: '1' }));
});

test('prepare and launch advance only on exact matching reviewed messages and causal revisions', () => {
  let flow = ready();
  assert.throws(() => beginRequest(flow, 'action', 'prepare', prep, uuid()));
  const first = review(flow, 'prepare', prep); flow = first.flow;
  const prepareRequest = beginRequest(flow, 'action', 'prepare', prep, uuid(), 1001);
  assert.equal(prepareRequest.envelope.reviewId, first.response.reviewId);
  flow = receiveResult(prepareRequest.flow, result(prepareRequest, preparedState()));
  assert.equal(flow.server.phase, 'prepared'); assert.equal(flow.receipts.length, 1); assert.equal(flow.review, null);
  flow = review(flow, 'launch', launch).flow;
  const launchRequest = beginRequest(flow, 'action', 'launch', launch, uuid(), 1001);
  flow = receiveResult(launchRequest.flow, result(launchRequest, launchedState()));
  assert.equal(flow.server.phase, 'launched'); assert.equal(flow.receipts.length, 2);
  assert.throws(() => beginRequest(flow, 'review', 'prepare', prep, uuid()));
});

test('buy and sell require causal quotes, actual reviews, explicit minimums and next-revision outcomes', () => {
  let flow = ready(launchedState());
  assert.throws(() => review(flow, 'buy', trade));
  flow = quoted(flow); assert.equal(flow.status, 'quoted'); assert.equal(flow.receipts.length, 0);
  flow = review(flow, 'buy', trade).flow;
  const buy = beginRequest(flow, 'action', 'buy', trade, uuid(), 1001);
  flow = receiveResult(buy.flow, result(buy, launchedState({ revision: 3, balances: { traderBaseRaw: '500', traderQuoteRaw: '99999900' } })));
  assert.equal(flow.server.balances.traderBaseRaw, '500'); assert.equal(flow.quote, null);
  const sellInput = { direction: 'sell', amountInRaw: '200', minAmountOutRaw: '1' };
  flow = quoted(flow, sellInput); flow = review(flow, 'sell', sellInput).flow;
  const sell = beginRequest(flow, 'action', 'sell', sellInput, uuid(), 1001);
  flow = receiveResult(sell.flow, result(sell, launchedState({ revision: 4, balances: { traderBaseRaw: '300', traderQuoteRaw: '99999940' } })));
  assert.equal(flow.server.balances.traderBaseRaw, '300'); assert.deepEqual(flow.receipts.map(item => item.action), ['buy', 'sell']);
});

test('edit, invalid edit, cancel, expiry and quote mismatch invalidate approvals', () => {
  const flow = review(quoted(), 'buy', trade).flow;
  for (const changed of [invalidate(flow), invalidate(flow, 'Invalid amount'), cancelReview(flow)]) {
    assert.equal(changed.quote, null); assert.equal(changed.review, null);
    assert.throws(() => beginRequest(changed, 'action', 'buy', trade, uuid(), 1001));
  }
  assert.equal(cancelReview(flow).status, 'cancelled');
  assert.throws(() => beginRequest(flow, 'action', 'buy', trade, uuid(), 100000));
  assert.throws(() => beginRequest(flow, 'action', 'buy', { ...trade, amountInRaw: '101' }, uuid(), 1001));
  assert.throws(() => beginRequest(flow, 'action', 'buy', { ...trade, minAmountOutRaw: '2' }, uuid(), 1001));
  assert.throws(() => beginRequest(flow, 'review', 'sell', { ...trade, direction: 'sell' }, uuid(), 1001));
});

test('unknown outcomes lock execution and cannot be unlocked by a normal state read', () => {
  const reviewed = review(ready(), 'prepare', prep).flow;
  const request = beginRequest(reviewed, 'action', 'prepare', prep, uuid(), 1001);
  let locked = unknown(request.flow, 'Transport failed');
  assert.equal(locked.locked, true); assert.equal(locked.review, null);
  assert.throws(() => beginRequest(locked, 'review', 'prepare', prep, uuid()));
  locked = receiveState(locked, state()); assert.equal(locked.locked, true); assert.equal(locked.status, 'uncertain');
  assert.throws(() => receiveResult(locked, result(request, preparedState())));
  const unresolved = receiveResult(request.flow, result(request, state({ revision: 1, phase: 'uncertain' }), { outcome: 'unresolved', messageSha256: null, error: 'VM outcome missing' }), 503);
  assert.equal(unresolved.status, 'uncertain'); assert.equal(unresolved.receipts.length, 0);
});

test('program failures retain actual balances and message provenance, then require fresh review', () => {
  const flow = review(quoted(), 'buy', trade).flow;
  const request = beginRequest(flow, 'action', 'buy', trade, uuid(), 1001);
  const failed = receiveResult(request.flow, result(request, launchedState({ revision: 3, balances: { traderBaseRaw: '0', traderQuoteRaw: '99995000' } }), { outcome: 'program-failed', error: 'MaxWalletExceeded' }));
  assert.equal(failed.status, 'program-failed'); assert.equal(failed.error, 'MaxWalletExceeded'); assert.equal(failed.locked, false);
  assert.equal(failed.lastResult.messageSha256, hash); assert.equal(failed.server.balances.traderQuoteRaw, '99995000'); assert.equal(failed.review, null); assert.equal(failed.quote, null);
  assert.doesNotThrow(() => quoted(failed));
});

test('synthetic pause and resume are separately identified controls with no message receipt', () => {
  const flow = ready(launchedState());
  const request = beginRequest(flow, 'action', 'pause', { paused: true }, uuid());
  assert.equal(Object.hasOwn(request.envelope, 'reviewId'), false);
  let paused = receiveResult(request.flow, result(request, launchedState({ revision: 3, phase: 'paused' }), { messageSha256: null }));
  assert.equal(paused.server.phase, 'paused');
  const resume = beginRequest(paused, 'action', 'pause', { paused: false }, uuid());
  paused = receiveResult(resume.flow, result(resume, launchedState({ revision: 4 }), { messageSha256: null }));
  assert.equal(paused.server.phase, 'launched');
});

test('strict rejection schema distinguishes stale and pre-execution invalid without fake outcomes', () => {
  const request = beginRequest(ready(), 'review', 'prepare', prep, uuid());
  const rejection = { schema: 'repoing/max-wallet-local-error/1', requestId: request.envelope.requestId, action: 'prepare', code: 'STALE_REVISION', error: 'Refresh current state', executionAttempted: false, canSign: false, canSubmit: false };
  const stale = receiveRejection(request.flow, rejection, 409);
  assert.equal(stale.status, 'stale'); assert.equal(stale.server.revision, 0); assert.equal(stale.receipts.length, 0);
  assert.throws(() => beginRequest(stale, 'review', 'prepare', prep, uuid()));
  assert.doesNotThrow(() => beginRequest(receiveState(stale, state()), 'review', 'prepare', prep, uuid()));
  const invalid = receiveRejection(request.flow, { ...rejection, code: 'INVALID_INPUT' }, 422);
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.locked, false);
  assert.throws(() => receiveRejection(request.flow, { ...rejection, executionAttempted: true }, 422));
  assert.throws(() => receiveRejection(request.flow, { ...rejection, requestId: uuid() }, 409));
});

test('malformed state, unknown flags/actions and changed original test identity are rejected', () => {
  for (const bad of [{ mode: 'mainnet' }, { canSign: true }, { canSubmit: true }, { productionPreparationReceiptAccepted: true }, { phase: 'confirmed' }, { supportedActions: ['sign'] }, { revision: -1 }, { unknownFlag: false }, { profileSha256: 'nope' }, { balances: { traderBaseRaw: '1e9', traderQuoteRaw: '0' } }]) assert.throws(() => parseState(state(bad)));
  assert.throws(() => receiveState(ready(), state({ sessionId: 'other-session' })));
  assert.throws(() => receiveState(ready(), state({ profileSha256: otherHash })));
  assert.throws(() => receiveState(ready(), state({ identities: { ...state().identities, trader: '22222222222222222222222222222222' } })));
  assert.throws(() => receiveState(ready(preparedState()), state()));
  assert.throws(() => receiveState(ready(launchedState()), state({ revision: 3 })));
  assert.throws(() => receiveState(ready(preparedState()), preparedState({ revision: 2, policy: { capBps: 200, rawCap: '20000000000000', initialSupply: '1000000000000000' } })));
  assert.throws(() => receiveState(ready(launchedState()), launchedState({ balances: { traderBaseRaw: '1', traderQuoteRaw: '1' } })));
  assert.throws(() => parseState(preparedState({ policy: { ...preparedState().policy, rawCap: '1' } })));
  assert.equal(receiveState(createFlow(), state({ phase: 'uncertain' })).locked, true);
});

test('HTTP200 alone, wrong action/request/hash/phase/revision, replay and oversized reviews never prove success', () => {
  const reviewed = review(ready(), 'prepare', prep);
  const request = beginRequest(reviewed.flow, 'action', 'prepare', prep, uuid(), 1001);
  const base = result(request, preparedState());
  for (const patch of [{ requestId: uuid() }, { action: 'launch' }, { messageSha256: otherHash }, { messageSha256: null }, { outcome: 'quoted' }, { state: preparedState({ revision: 0 }) }, { state: preparedState({ revision: 2 }) }, { state: preparedState({ phase: 'launched' }) }]) assert.throws(() => receiveResult(request.flow, { ...base, ...patch }));
  const complete = receiveResult(request.flow, base); assert.throws(() => receiveResult(complete, base));
  assert.throws(() => receiveReview(reviewed.request.flow, { ...reviewed.response, wireBytes: 1233 }, 1000));
  assert.throws(() => receiveReview(reviewed.request.flow, { ...reviewed.response, expiresAtMs: 999 }, 1000));
  assert.throws(() => receiveReview(reviewed.request.flow, { ...reviewed.response, expiresAtMs: Number.MAX_SAFE_INTEGER }, 1000));
  assert.throws(() => receiveReview(reviewed.request.flow, { ...reviewed.response, requiredSigners: [] }, 1000));
  assert.throws(() => receiveReview(reviewed.request.flow, { ...reviewed.response, revision: 2 }, 1000));
  assert.throws(() => beginRequest(request.flow, 'review', 'prepare', prep, uuid()));
  assert.throws(() => invalidate(request.flow));
});

test('quote cannot secretly execute, mutate balances or be rebound to another amount', () => {
  const flow = ready(launchedState());
  const request = beginRequest(flow, 'quote', 'quote', { ...trade, minAmountOutRaw: '0' }, uuid());
  const base = result(request, flow.server, { outcome: 'quoted', messageSha256: null, quote: { direction: 'buy', amountInRaw: '100', amountOutRaw: '500' } });
  for (const patch of [{ outcome: 'succeeded' }, { messageSha256: hash }, { quote: { ...base.quote, amountInRaw: '101' } }, { state: launchedState({ revision: 3 }) }, { state: launchedState({ balances: { traderBaseRaw: '500', traderQuoteRaw: '99999900' } }) }]) assert.throws(() => receiveResult(request.flow, { ...base, ...patch }));
  assert.throws(() => parseResult({ ...base, executionEnabled: true }));
});

test('response parser bounds content length and streamed bytes, verifies MIME and valid JSON', async () => {
  const good = new Response(JSON.stringify(state()), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.equal((await readBoundedJson(good)).schema, STATE_SCHEMA);
  await assert.rejects(readBoundedJson(new Response('{}', { headers: { 'content-type': 'text/html' } })));
  await assert.rejects(readBoundedJson(new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) } })));
  await assert.rejects(readBoundedJson(new Response(' '.repeat(MAX_RESPONSE_BYTES + 1), { headers: { 'content-type': 'application/json' } })));
  await assert.rejects(readBoundedJson(new Response('{broken', { headers: { 'content-type': 'application/json' } })));
});
