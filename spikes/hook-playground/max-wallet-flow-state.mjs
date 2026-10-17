/** Local-only max-wallet transport/state machine. No wallets, storage, RPC or signing. */
export const STATE_SCHEMA = 'repoing/max-wallet-local-state/1';
export const ACTION_SCHEMA = 'repoing/max-wallet-local-action/1';
export const RESULT_SCHEMA = 'repoing/max-wallet-local-result/1';
export const REVIEW_SCHEMA = 'repoing/max-wallet-local-review/1';
export const MAX_RESPONSE_BYTES = 65536;
const ACTIONS = ['prepare', 'launch', 'quote', 'buy', 'sell', 'pause'];
const PHASES = ['unprepared', 'prepared', 'launched', 'paused', 'uncertain'];
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const U64_MAX = 18446744073709551615n;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, required, optional = []) {
  assert(object(value), 'Expected an object.');
  assert(required.every(key => Object.hasOwn(value, key)), 'Response is missing a required field.');
  assert(Object.keys(value).every(key => [...required, ...optional].includes(key)), 'Response contains unsupported fields.');
}
function text(value, max, label, minimum = 1) {
  assert(typeof value === 'string' && new TextEncoder().encode(value).length <= max && value.length >= minimum, `${label} is missing or too long.`);
  assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), `${label} contains control characters.`);
  return value;
}
export function rawAmount(value, positive = false) {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= U64_MAX, 'Enter a whole, canonical raw-unit amount within u64.');
  assert(!positive || BigInt(value) > 0n, 'Enter an amount greater than zero.');
  return value;
}
function integer(value, minimum = 0) { assert(Number.isSafeInteger(value) && value >= minimum, 'Invalid integer in response.'); }
function flags(value) { assert(value.canSign === false && value.canSubmit === false, 'Production permissions are forbidden in this local test.'); }
export function parseState(value) {
  fields(value, ['schema', 'mode', 'sessionId', 'revision', 'phase', 'policy', 'identities', 'balances', 'supportedActions', 'canSign', 'canSubmit', 'productionPreparationReceiptAccepted', 'profileSha256', 'notice'], ['slot', 'blockHeight', 'blockhash', 'paused', 'historyDigest']);
  assert(value.schema === STATE_SCHEMA && value.mode === 'synthetic-sbf', 'Unsupported local state.');
  text(value.sessionId, 128, 'Session identity'); integer(value.revision);
  assert(PHASES.includes(value.phase), 'Unknown local phase.'); flags(value);
  assert(value.productionPreparationReceiptAccepted === false, 'Production preparation receipts are not accepted.');
  assert(HASH.test(value.profileSha256), 'Invalid profile hash.'); text(value.notice, 2048, 'Local notice');
  fields(value.policy, ['capBps', 'rawCap', 'initialSupply']);
  rawAmount(value.policy.initialSupply, true);
  assert(value.policy.capBps === null || Number.isInteger(value.policy.capBps) && value.policy.capBps >= 1 && value.policy.capBps <= 9999, 'Invalid cap.');
  if (value.policy.rawCap !== null) {
    rawAmount(value.policy.rawCap);
    assert(value.policy.rawCap === (BigInt(value.policy.initialSupply) * BigInt(value.policy.capBps) / 10000n).toString(), 'Policy raw cap differs from the explicit initial-supply cap.');
  }
  assert((value.policy.capBps === null) === (value.policy.rawCap === null), 'Incomplete cap policy.');
  assert(value.phase === 'unprepared' || value.phase === 'uncertain' || value.policy.capBps !== null, 'Prepared state has no policy.');
  fields(value.identities, ['creator', 'mint', 'selectedConfig', 'trader']);
  for (const address of Object.values(value.identities)) assert(KEY.test(address), 'Invalid public test identity.');
  fields(value.balances, ['traderBaseRaw', 'traderQuoteRaw']);
  rawAmount(value.balances.traderBaseRaw); rawAmount(value.balances.traderQuoteRaw);
  assert(Array.isArray(value.supportedActions) && value.supportedActions.length <= ACTIONS.length && value.supportedActions.every(action => ACTIONS.includes(action)) && new Set(value.supportedActions).size === value.supportedActions.length, 'Unknown or duplicate local action.');
  for (const field of ['slot', 'blockHeight']) if (Object.hasOwn(value, field)) integer(value[field]);
  if (Object.hasOwn(value, 'blockhash')) assert(KEY.test(value.blockhash), 'Invalid blockhash.');
  if (Object.hasOwn(value, 'paused')) assert(typeof value.paused === 'boolean', 'Invalid pause state.');
  if (Object.hasOwn(value, 'historyDigest')) assert(HASH.test(value.historyDigest), 'Invalid history digest.');
  return structuredClone(value);
}
export function validateInput(action, input) {
  assert(ACTIONS.includes(action), 'Unsupported action.');
  if (action === 'prepare') {
    fields(input, ['capBps', 'label']);
    assert(Number.isInteger(input.capBps) && input.capBps >= 1 && input.capBps <= 9999, 'Choose an explicit wallet cap from 1 to 9999 basis points.');
    text(input.label, 32, 'Policy label');
  } else if (action === 'launch') {
    fields(input, ['name', 'symbol', 'uri', 'virtualQuote']);
    text(input.name, 32, 'Token name'); text(input.symbol, 10, 'Symbol'); text(input.uri, 200, 'Metadata URI', 0); rawAmount(input.virtualQuote, true);
  } else if (action === 'pause') {
    fields(input, ['paused']); assert(typeof input.paused === 'boolean', 'Choose an explicit pause state.');
  } else {
    fields(input, ['direction', 'amountInRaw', 'minAmountOutRaw']);
    assert(['buy', 'sell'].includes(input.direction) && (action === 'quote' || input.direction === action), 'Trade direction does not match.');
    rawAmount(input.amountInRaw, true); rawAmount(input.minAmountOutRaw, action !== 'quote');
    if (action === 'quote') assert(input.minAmountOutRaw === '0', 'Non-executing quotes use an explicit minimum of zero.');
  }
  return structuredClone(input);
}
export function createFlow() {
  return { server: null, status: 'idle', pending: null, review: null, quote: null, lastResult: null, receipts: [], error: '', locked: false, generation: 0 };
}
function sameIdentity(a, b) {
  assert(a.sessionId === b.sessionId && a.profileSha256 === b.profileSha256 && Object.keys(a.identities).every(key => a.identities[key] === b.identities[key]), 'The local session or its original test identities changed. Start a new test deliberately.');
}
function sameState(a, b) {
  sameIdentity(a, b);
  assert(a.revision === b.revision && a.phase === b.phase && JSON.stringify(a.policy) === JSON.stringify(b.policy) && JSON.stringify(a.balances) === JSON.stringify(b.balances), 'A read-only response changed the execution state.');
}
export function receiveState(flow, value) {
  assert(!flow.pending, 'An action is still pending.');
  const state = parseState(value);
  if (flow.server) {
    sameIdentity(flow.server, state);
    assert(state.revision >= flow.server.revision, 'State revision moved backwards.');
    assert(state.policy.initialSupply === flow.server.policy.initialSupply, 'Initial supply changed unexpectedly.');
    if (flow.server.policy.capBps !== null) assert(JSON.stringify(state.policy) === JSON.stringify(flow.server.policy), 'Immutable prepared policy changed.');
    if (state.revision === flow.server.revision && ![state.phase, flow.server.phase].includes('uncertain')) sameState(flow.server, state);
    const progress = { unprepared: 0, prepared: 1, launched: 2, paused: 2, uncertain: 3 };
    if (flow.server.phase !== 'uncertain') assert(progress[state.phase] >= progress[flow.server.phase], 'Execution phase moved backwards.');
  }
  return { ...flow, server: state, status: flow.locked || state.phase === 'uncertain' ? 'uncertain' : 'ready', locked: flow.locked || state.phase === 'uncertain', review: null, quote: null, error: flow.locked ? flow.error : '', generation: flow.generation + 1 };
}
export function invalidate(flow, reason = '') {
  assert(!flow.pending, 'Do not edit a pending request.');
  return { ...flow, review: null, quote: null, generation: flow.generation + 1, error: reason, status: flow.locked ? 'uncertain' : reason ? 'invalid' : 'ready' };
}
export function cancelReview(flow) { return { ...invalidate(flow), status: flow.locked ? 'uncertain' : 'cancelled' }; }
function permitted(flow, action) {
  assert(flow.server && !flow.pending && !flow.locked && !['uncertain', 'stale', 'unavailable'].includes(flow.status), 'Refresh stale state or restart an uncertain local session before continuing.');
  assert(flow.server.supportedActions.includes(action), 'This action is not supported in the current local state.');
  const phase = flow.server.phase;
  assert(action === 'prepare' ? phase === 'unprepared' : action === 'launch' ? phase === 'prepared' : ['launched', 'paused'].includes(phase), 'Action does not match the current step.');
}
export function beginRequest(flow, kind, action, rawInput, requestId, now = Date.now()) {
  assert(['review', 'action', 'quote'].includes(kind) && UUID.test(requestId), 'Invalid request identity.');
  permitted(flow, action);
  const input = validateInput(action, rawInput);
  assert(kind !== 'quote' || action === 'quote', 'Quote request differs.');
  assert(kind !== 'review' || ['prepare', 'launch', 'buy', 'sell'].includes(action), 'This action does not have a transaction review.');
  if (['buy', 'sell'].includes(action)) {
    assert(flow.quote && flow.quote.revision === flow.server.revision && flow.quote.direction === action && flow.quote.amountInRaw === input.amountInRaw && flow.quote.generation === flow.generation, 'Get a fresh quote for this exact trade before review.');
  }
  if (kind === 'action' && action !== 'pause') {
    assert(flow.review && flow.review.action === action && JSON.stringify(flow.review.input) === JSON.stringify(input) && flow.review.revision === flow.server.revision && flow.review.generation === flow.generation && flow.review.expiresAtMs > now, 'Review this exact request again before execution.');
  }
  const envelope = { schema: ACTION_SCHEMA, requestId, expectedRevision: flow.server.revision, action, input };
  if (kind === 'action' && action !== 'pause') envelope.reviewId = flow.review.reviewId;
  const pending = { kind, requestId, action, input, generation: flow.generation, revision: flow.server.revision, messageSha256: kind === 'action' ? flow.review?.messageSha256 ?? null : null };
  return { flow: { ...flow, pending, status: 'pending', error: '', ...(kind === 'review' ? { review: null } : {}) }, envelope };
}
export function receiveReview(flow, value, now = Date.now()) {
  const pending = flow.pending;
  assert(pending?.kind === 'review', 'No matching review request.');
  fields(value, ['schema', 'requestId', 'reviewId', 'action', 'revision', 'sessionId', 'profileSha256', 'messageSha256', 'wireBytes', 'requiredSigners', 'expiresAtMs', 'canSign', 'canSubmit']);
  assert(value.schema === REVIEW_SCHEMA && value.requestId === pending.requestId && value.action === pending.action && UUID.test(value.reviewId), 'Review does not match the requested action.');
  assert(value.revision === pending.revision && value.sessionId === flow.server.sessionId && value.profileSha256 === flow.server.profileSha256 && pending.generation === flow.generation, 'Review is stale or belongs to another session.');
  flags(value); assert(HASH.test(value.messageSha256), 'Review lacks an exact message hash.');
  integer(value.wireBytes, 1); assert(value.wireBytes <= 1232, 'Review message is too large.');
  assert(Array.isArray(value.requiredSigners) && value.requiredSigners.length >= 1 && value.requiredSigners.length <= 16 && value.requiredSigners.every(key => KEY.test(key)) && new Set(value.requiredSigners).size === value.requiredSigners.length, 'Invalid required signer list.');
  integer(value.expiresAtMs, 1); assert(value.expiresAtMs > now && value.expiresAtMs <= now + 300000, 'Review is expired or its lifetime exceeds the local bound.');
  return { ...flow, pending: null, review: { ...structuredClone(value), input: pending.input, generation: flow.generation }, status: 'reviewed', error: '' };
}
export function parseResult(value) {
  fields(value, ['schema', 'requestId', 'action', 'outcome', 'messageSha256', 'state', 'canSign', 'canSubmit'], ['quote', 'error']);
  assert(value.schema === RESULT_SCHEMA && UUID.test(value.requestId) && ACTIONS.includes(value.action), 'Invalid action result.');
  assert(['succeeded', 'program-failed', 'unresolved', 'quoted'].includes(value.outcome), 'Unknown action outcome.');
  assert(value.messageSha256 === null || HASH.test(value.messageSha256), 'Invalid message hash.'); flags(value);
  if (value.error !== undefined) text(value.error, 4096, 'Program error');
  const state = parseState(value.state);
  if (value.quote !== undefined) {
    fields(value.quote, ['direction', 'amountInRaw', 'amountOutRaw']);
    assert(['buy', 'sell'].includes(value.quote.direction), 'Invalid quote direction.'); rawAmount(value.quote.amountInRaw, true); rawAmount(value.quote.amountOutRaw);
  }
  return { ...structuredClone(value), state };
}
export function receiveResult(flow, raw, httpStatus = 200) {
  const pending = flow.pending;
  assert(pending, 'No pending request for this result.');
  const value = parseResult(raw);
  assert(value.requestId === pending.requestId && value.action === pending.action && pending.generation === flow.generation, 'Result does not match the pending request.');
  sameIdentity(flow.server, value.state);
  assert(value.state.policy.initialSupply === flow.server.policy.initialSupply, 'Initial supply changed unexpectedly.');
  if (pending.action !== 'prepare') assert(JSON.stringify(value.state.policy) === JSON.stringify(flow.server.policy), 'Immutable prepared policy changed.');
  if (httpStatus !== 200 || value.outcome === 'unresolved') {
    assert(value.state.revision >= flow.server.revision, 'Uncertain state revision moved backwards.');
    return { ...unknown(flow, value.error || 'The local outcome is unresolved. Further execution is locked.'), server: value.state, lastResult: value };
  }
  if (pending.kind === 'quote') {
    assert(value.action === 'quote' && value.outcome === 'quoted' && value.messageSha256 === null && value.quote && value.quote.direction === pending.input.direction && value.quote.amountInRaw === pending.input.amountInRaw, 'Quote does not match the request.');
    sameState(flow.server, value.state);
    return { ...flow, pending: null, status: 'quoted', quote: { ...value.quote, requestId: value.requestId, revision: value.state.revision, generation: flow.generation }, review: null, error: '' };
  }
  assert(pending.kind === 'action' && ['succeeded', 'program-failed'].includes(value.outcome) && !value.quote, 'HTTP success does not prove execution.');
  assert(value.state.revision === pending.revision + 1, 'Execution revision is not causal.');
  if (pending.action === 'pause') assert(value.messageSha256 === null, 'Pause is a test control, not a transaction receipt.');
  else assert(value.messageSha256 !== null && value.messageSha256 === pending.messageSha256, 'Executed message hash differs from the exact review.');
  if (value.outcome === 'succeeded') {
    const phase = pending.action === 'prepare' ? 'prepared' : pending.action === 'launch' ? 'launched' : pending.action === 'pause' ? pending.input.paused ? 'paused' : 'launched' : flow.server.phase;
    assert(value.state.phase === phase, 'Successful result has the wrong phase.');
    if (pending.action === 'prepare') assert(value.state.policy.capBps === pending.input.capBps, 'Prepared cap differs from review.');
  } else assert(value.state.phase === flow.server.phase, 'Failed program unexpectedly changed phase.');
  return { ...flow, server: value.state, pending: null, review: null, quote: null, status: value.outcome, lastResult: value, receipts: [...flow.receipts, value].slice(-30), generation: flow.generation + 1, error: value.outcome === 'program-failed' ? value.error || 'The program rejected this exact message.' : '' };
}
export function receiveRejection(flow, value, httpStatus) {
  const pending = flow.pending;
  assert(pending && [409, 422].includes(httpStatus), 'No matching rejected request.');
  fields(value, ['schema', 'requestId', 'action', 'code', 'error', 'executionAttempted', 'canSign', 'canSubmit']);
  assert(value.schema === 'repoing/max-wallet-local-error/1' && value.requestId === pending.requestId && value.action === pending.action, 'Rejection does not match this request.');
  assert(['INVALID_INPUT', 'STALE_REVISION', 'REVIEW_EXPIRED', 'REVIEW_MISMATCH', 'UNAVAILABLE'].includes(value.code) && value.executionAttempted === false, 'Rejection does not establish a pre-execution failure.');
  flags(value); text(value.error, 4096, 'Runner error');
  return { ...flow, pending: null, review: null, quote: null, status: httpStatus === 409 || value.code === 'STALE_REVISION' ? 'stale' : 'invalid', error: value.error };
}
export function unknown(flow, error = 'The request outcome is unknown. Further execution is locked.') {
  return { ...flow, status: 'uncertain', pending: null, review: null, quote: null, locked: true, generation: flow.generation + 1, error };
}
export async function readBoundedJson(response) {
  assert(response.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'Local runner returned a non-JSON response.');
  const length = response.headers.get('content-length');
  if (length !== null) assert(/^\d+$/.test(length) && Number(length) <= MAX_RESPONSE_BYTES, 'Local response is too large.');
  const reader = response.body?.getReader(); assert(reader, 'Local response has no body.');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let source = '', count = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; count += value.byteLength; assert(count <= MAX_RESPONSE_BYTES, 'Local response is too large.'); source += decoder.decode(value, { stream: true }); }
    source += decoder.decode(); return JSON.parse(source);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
}
