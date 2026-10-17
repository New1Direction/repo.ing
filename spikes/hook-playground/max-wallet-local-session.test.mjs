import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createVmTransport, MaxWalletLocalSession, parseLocalAction, canonicalJson, sha, validateVmResponse, buildLocalPlan } from './max-wallet-local-session.mjs';
import { defaultDriverConfiguration } from './max-wallet-local-server.mjs';

const envelope = (action = 'prepare', input = { capBps: 100, label: 'Explicit test' }) => ({ schema: 'repoing/max-wallet-local-action/1', requestId: randomUUID(), expectedRevision: 0, action, input });
const initial = JSON.parse(await readFile(new URL('../../../recovered-amp/audit/maxwallet-browser/initial.json', import.meta.url)));
function mockTransport({ failAction = null, unknownField = false } = {}) {
  const snapshot = structuredClone(initial); let calls = [];
  return { calls, async close() {}, async request(request) {
    calls.push(request);
    if (request.action === failAction) throw Error('/private/secret.env should never appear');
    const value = { ...structuredClone(snapshot), id: request.id, action: request.action, requestDigest: sha(canonicalJson(request)) };
    if (unknownField) value.unknown = true;
    return value;
  } };
}

test('canonical request digest sorts objects recursively but preserves array order', () => {
  assert.equal(canonicalJson({ z: [{ y: 2, a: 1 }], a: false }), '{"a":false,"z":[{"a":1,"y":2}]}');
  assert.notEqual(sha(canonicalJson([1, 2])), sha(canonicalJson([2, 1])));
});
test('strict input schemas reject missing/unknown fields, invalid unicode and unsafe amounts', () => {
  for (const change of [v => ({ ...v, wallet: 'injected' }), v => ({ ...v, expectedRevision: -1 }), v => ({ ...v, requestId: 'reuse' }),
    v => ({ ...v, input: { capBps: 0, label: 'test' } }), v => ({ ...v, input: { capBps: 100, label: '\ud800' } }),
    v => ({ ...v, input: { capBps: 100, label: 'a'.repeat(33) } }), v => ({ ...v, input: { capBps: 100, label: 'test', rules: {} } })]) {
    assert.throws(() => parseLocalAction(change(envelope()), 'review'), { code: 'INVALID_INPUT' });
  }
  for (const amount of ['01', '-1', '0', '1.0', '1e6', '18446744073709551616']) assert.throws(() => parseLocalAction(envelope('quote', { direction: 'buy', amountInRaw: amount, minAmountOutRaw: '0' }), 'action'));
  assert.throws(() => parseLocalAction(envelope('buy', { direction: 'sell', amountInRaw: '1', minAmountOutRaw: '1' }), 'review'));
  assert.throws(() => parseLocalAction(envelope('pause', { paused: true }), 'review'));
  assert.throws(() => parseLocalAction(envelope(), 'action'));
  assert.throws(() => parseLocalAction({ ...envelope(), reviewId: randomUUID() }, 'review'));
  assert.equal(parseLocalAction(envelope('prepare', { capBps: 9999, label: '🐈' }), 'review').input.label, '🐈');
});
test('VM boundary rejects unknown fields, changed hashes, missing explicit rows, privilege claims and mismatched identity', () => {
  const request = { schema: 'hooklab/max-wallet-vm-request/1', id: 'unit', action: 'state', expectedRevision: 0 };
  const response = { ...structuredClone(initial), id: request.id, requestDigest: sha(canonicalJson(request)) };
  assert.equal(validateVmResponse(response, request).revision, 0);
  for (const change of [v => ({ ...v, unexpected: true }), v => ({ ...v, canSign: true }), v => ({ ...v, signaturesVerified: true }),
    v => ({ ...v, id: 'different' }), v => ({ ...v, requestDigest: '0'.repeat(64) }), v => ({ ...v, accounts: [...v.accounts, v.accounts[0]] })]) assert.throws(() => validateVmResponse(change(response), request));
  const bad = structuredClone(response), row = bad.accounts.find(x => x.account); row.account.dataSha256 = '0'.repeat(64); assert.throws(() => validateVmResponse(bad, request));
  const missing = structuredClone(response); missing.accounts = missing.accounts.filter(x => x.pubkey !== 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft');
  assert.throws(() => buildLocalPlan('prepare', { capBps: 100, label: 'x' }, missing, null), /omitted/);
});
test('real builder rebinds changed user cap and label; review has no VM write and stale/mismatched/expired executions fail closed', async () => {
  let now = 10000; const transport = mockTransport(), s = new MaxWalletLocalSession({ transport, now: () => now });
  await s.initialize();
  const value = envelope('prepare', { capBps: 250, label: 'Causal input' }), review = await s.review(value);
  assert.equal(transport.calls.length, 1); assert.ok(review.wireBytes <= 1232);
  const row = s.reviews.get(review.reviewId); assert.equal(row.plan.request.capBps, 250); assert.equal(row.plan.request.label, 'Causal input');
  assert.equal(row.plan.policy.capRaw, '25000000000000');
  assert.deepEqual(await s.review(value), review);
  await assert.rejects(s.review({ ...value, input: { ...value.input, capBps: 251 } }), { code: 'REVIEW_MISMATCH' });
  await assert.rejects(s.action({ ...value, requestId: randomUUID(), reviewId: review.reviewId, expectedRevision: 1 }), { code: 'STALE_REVISION' });
  await assert.rejects(s.action({ ...value, requestId: randomUUID(), reviewId: review.reviewId, input: { capBps: 250, label: 'changed' } }), { code: 'REVIEW_MISMATCH' });
  now += 30001;
  await assert.rejects(s.action({ ...value, requestId: randomUUID(), reviewId: review.reviewId }), { code: 'REVIEW_EXPIRED' });
  assert.equal(transport.calls.length, 1); await s.close();
});
test('unknown dispatch stays locked after state read, cannot retry or fabricate success, and errors are redacted', async () => {
  const transport = mockTransport({ failAction: 'prepare' }), s = new MaxWalletLocalSession({ transport }); await s.initialize();
  const value = envelope(), review = await s.review(value), action = { ...value, requestId: randomUUID(), reviewId: review.reviewId };
  const result = await s.action(action); assert.equal(result.outcome, 'unresolved'); assert.equal(result.state.phase, 'uncertain'); assert.ok(!JSON.stringify(result).includes('secret'));
  assert.deepEqual(await s.action(action), result); assert.equal(transport.calls.length, 2);
  assert.equal((await s.state()).phase, 'uncertain');
  await assert.rejects(s.review(envelope()), { code: 'UNAVAILABLE', status: 503 });
  assert.equal(transport.calls.length, 3); await s.close();
});
test('request/review storage is bounded', async () => {
  const s = new MaxWalletLocalSession({ transport: mockTransport(), maxReviews: 1, maxHistory: 2 }); await s.initialize();
  await s.review(envelope()); await assert.rejects(s.review(envelope()), { code: 'UNAVAILABLE' }); assert.equal(s.reviews.size, 1); await s.close();
});
test('child environment refuses secrets and transport caps output, time, count and close', async () => {
  await assert.rejects(createVmTransport({ command: process.execPath, env: { SOLANA_PRIVATE_KEY: 'never-forward' } }), /public local fixture/);
  const dir = await mkdtemp(join(tmpdir(), 'hook-local-'));
  try {
    const file = join(dir, 'driver.mjs');
    await writeFile(file, `import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',l=>{let v=JSON.parse(l);if(v.action==='hang')return;if(v.action==='big'){process.stdout.write('x'.repeat(4000));return;}console.log('VM_JSON '+JSON.stringify({id:v.id,env:Object.keys(process.env)}));});`);
    const t = await createVmTransport({ command: process.execPath, args: [file], maxBytes: 2048, timeoutMs: 100, maxRequests: 3 });
    const answer = await t.request({ id: 'one', action: 'state' }); assert.deepEqual(answer.env, ['LANG']);
    await assert.rejects(t.request({ id: 'two', action: 'hang' }), /unresolved/);
    await assert.rejects(t.request({ id: 'three', action: 'big' }), /unresolved/);
    await assert.rejects(t.request({ id: 'four', action: 'state' }), /unavailable/);
    await t.close(); assert.throws(() => process.kill(t.pid, 0));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
