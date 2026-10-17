import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startMaxWalletLocalServer } from './max-wallet-local-server.mjs';
import { createPlaygroundServer } from './server.mjs';

const raw = (url, { path = '/', method = 'GET', headers = {}, body = '' } = {}) => new Promise((resolve, reject) => {
  const u = new URL(url), req = http.request({ hostname: u.hostname, port: u.port, path, method, headers }, response => {
    const bytes = []; response.on('data', b => bytes.push(b)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(bytes).toString() }));
  }); req.on('error', reject); req.end(body);
});
const action = (revision, kind, input) => ({ schema: 'repoing/max-wallet-local-action/1', requestId: randomUUID(), expectedRevision: revision, action: kind, input });

test('separate opt-in server rejects default activation; original server remains networkless and hides local assets/routes', async () => {
  await assert.rejects(startMaxWalletLocalServer(), /Explicit localTest/);
  const server = await createPlaygroundServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`, page = await raw(url);
    assert.equal(page.status, 200); assert.match(page.headers['content-security-policy'], /connect-src 'none'/); assert.ok(!page.body.includes('hooklab-local-session'));
    for (const path of ['/max-wallet-flow.mjs', '/max-wallet-flow.css', '/__local/max-wallet/state']) assert.equal((await raw(url, { path })).status, 404);
    assert.equal((await raw(url, { path: '/__local/max-wallet/action', method: 'POST' })).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('actual SBF HTTP workflow and hostile boundary checks, no mocked chain execution', { timeout: 45000 }, async t => {
  const originalNames = ['index.html', 'app.mjs', 'style.css', 'model.mjs', 'draft.mjs', 'plain-draft.mjs', 'server.mjs'];
  const originals = await Promise.all(originalNames.map(name => readFile(new URL(name, import.meta.url))));
  const running = await startMaxWalletLocalServer({ localTest: true, port: 0 });
  try {
    const url = running.url, page = await raw(url), token = page.body.match(/name="hooklab-local-session" content="([^"]+)"/)[1];
    const headers = { 'Content-Type': 'application/json', Origin: url, 'X-Hooklab-Local': token };
    const post = async (path, value, override = {}) => { const result = await raw(url, { path: '/__local/max-wallet/' + path, method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(value) }); return { ...result, json: result.headers['content-type']?.startsWith('application/json') ? JSON.parse(result.body) : null }; };
    const readState = async () => { const r = await raw(url, { path: '/__local/max-wallet/state', headers: { 'X-Hooklab-Local': token } }); assert.equal(r.status, 200); return JSON.parse(r.body); };
    let state = await readState();
    await t.test('loopback, strict origin, CSRF, asset whitelist, JSON/body and method boundaries', async () => {
      assert.equal(running.server.address().address, '127.0.0.1'); assert.match(page.body, /id="max-wallet-local-open"/);
      assert.match(page.headers['content-security-policy'], /connect-src 'self'/); assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.headers['x-content-type-options'], 'nosniff');
      for (const path of ['/max-wallet-flow.mjs', '/max-wallet-flow.css', '/max-wallet-flow-state.mjs']) assert.equal((await raw(url, { path })).status, 200);
      for (const path of ['/../package.json', '/%2e%2e/package.json', '//index.html', '/max-wallet-local-session.mjs', '/.env', '/__local/max-wallet/reset', '/?foo=1']) assert.equal((await raw(url, { path })).status, 404);
      assert.equal((await raw(url, { headers: { Host: 'evil.example' } })).status, 403);
      assert.equal((await raw(url, { headers: ['Host', '127.0.0.1:' + new URL(url).port, 'Host', 'evil.example'] })).status, 403);
      assert.equal((await raw(url, { headers: { Origin: 'https://evil.example' } })).status, 403);
      assert.equal((await raw(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
      assert.equal((await raw(url, { path: '/__local/max-wallet/state' })).status, 403);
      const value = action(0, 'prepare', { capBps: 100, label: 'Explicit local test' });
      assert.equal((await post('review', value, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await post('review', value, { 'X-Hooklab-Local': 'wrong' })).status, 403);
      assert.equal((await raw(url, { path: '/__local/max-wallet/review', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hooklab-Local': token }, body: JSON.stringify(value) })).status, 403);
      assert.equal((await post('review', value, { 'Content-Type': 'text/plain' })).status, 422);
      assert.equal((await post('review', { ...value, unexpected: true })).status, 422);
      const huge = await raw(url, { path: '/__local/max-wallet/review', method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(9000) }) }); assert.equal(huge.status, 413);
      assert.equal((await raw(url, { path: '/__local/max-wallet/state', method: 'POST', headers })).status, 405);
      assert.equal((await readState()).revision, 0);
    });
    async function execute(kind, input) {
      const value = action(state.revision, kind, input), reviewed = await post('review', value);
      assert.equal(reviewed.status, 200, reviewed.body); assert.equal(reviewed.json.canSign, false); assert.ok(reviewed.json.wireBytes <= 1232);
      const executable = { ...value, requestId: randomUUID(), reviewId: reviewed.json.reviewId }, result = await post('action', executable);
      assert.equal(result.status, 200, result.body); assert.equal(result.json.outcome, 'succeeded', result.body);
      assert.equal(result.json.messageSha256, reviewed.json.messageSha256); assert.equal(result.json.state.revision, state.revision + 1);
      const replay = await post('action', executable); assert.deepEqual(replay.json, result.json);
      state = result.json.state; return result;
    }
    await t.test('exact reviewed prepare then launch, using real SBF responses and actual prepared state', async () => {
      await execute('prepare', { capBps: 100, label: 'Browser synthetic test' }); assert.equal(state.phase, 'prepared'); assert.equal(state.policy.rawCap, '10000000000000');
      const stale = await post('review', action(0, 'prepare', { capBps: 100, label: 'Browser synthetic test' })); assert.equal(stale.status, 409); assert.equal(stale.json.executionAttempted, false);
      await execute('launch', { name: 'Local SBF test', symbol: 'LSBF', uri: '', virtualQuote: '1000000000' }); assert.equal(state.phase, 'launched');
      assert.equal(state.balances.traderBaseRaw, '0'); assert.equal(state.productionPreparationReceiptAccepted, false);
    });
    await t.test('actual nonexecuting quote, successful exact-message buy and sell with causal balances', async () => {
      const quote = await post('action', action(state.revision, 'quote', { direction: 'buy', amountInRaw: '1000000', minAmountOutRaw: '0' }));
      assert.equal(quote.status, 200, quote.body); assert.equal(quote.json.outcome, 'quoted'); assert.equal(quote.json.state.revision, state.revision);
      assert.equal(quote.json.quote.amountOutRaw, '1123876123876'); assert.equal(quote.json.messageSha256, null);
      await execute('buy', { direction: 'buy', amountInRaw: '1000000', minAmountOutRaw: '1' });
      assert.deepEqual(state.balances, { traderBaseRaw: '1123876123876', traderQuoteRaw: '19999000000' });
      await execute('sell', { direction: 'sell', amountInRaw: '1000000000', minAmountOutRaw: '1' });
      assert.deepEqual(state.balances, { traderBaseRaw: '1122876123876', traderQuoteRaw: '19999000890' });
    });
    await t.test('cap, slippage and paused cases are truthful pre-execution refusals; no forged program receipt', async () => {
      for (const [amount, minimum, message] of [['100000000', '1', /cap/], ['1000000', '18446744073709551615', /minimum output/]]) {
        const before = await readState(), rejected = await post('review', action(state.revision, 'buy', { direction: 'buy', amountInRaw: amount, minAmountOutRaw: minimum }));
        assert.equal(rejected.status, 422, rejected.body); assert.equal(rejected.json.executionAttempted, false); assert.match(rejected.json.error, message); assert.equal(rejected.json.messageSha256, undefined);
        const after = await readState(); assert.equal(after.revision, before.revision); assert.equal(after.historyDigest, before.historyDigest); assert.deepEqual(after.balances, before.balances);
      }
      const paused = await post('action', action(state.revision, 'pause', { paused: true })); assert.equal(paused.status, 200, paused.body); state = paused.json.state;
      assert.equal(state.phase, 'paused'); assert.equal(paused.json.messageSha256, null);
      const rejected = await post('review', action(state.revision, 'buy', { direction: 'buy', amountInRaw: '1000000', minAmountOutRaw: '1' })); assert.equal(rejected.status, 422); assert.equal(rejected.json.executionAttempted, false); assert.match(rejected.json.error, /paused/);
      const resumed = await post('action', action(state.revision, 'pause', { paused: false })); assert.equal(resumed.status, 200); state = resumed.json.state; assert.equal(state.phase, 'launched');
      assert.equal(state.revision, 6);
    });
    const after = await Promise.all(originalNames.map(name => readFile(new URL(name, import.meta.url)))); after.forEach((bytes, i) => assert.deepEqual(bytes, originals[i], originalNames[i]));
  } finally { await running.close(); }
});

test('generic post-dispatch exceptions never claim executionAttempted:false and lock the session', async () => {
  const session = { uncertain: false, async initialize() {}, async close() {}, async action() { throw Error('/private/secret.env'); } };
  const running = await startMaxWalletLocalServer({ localTest: true, port: 0, session });
  try {
    const page = await raw(running.url), token = page.body.match(/name="hooklab-local-session" content="([^"]+)"/)[1];
    const response = await raw(running.url, { path: '/__local/max-wallet/action', method: 'POST', headers: { Origin: running.url, 'X-Hooklab-Local': token, 'Content-Type': 'application/json' }, body: JSON.stringify(action(0, 'pause', { paused: true })) });
    assert.equal(response.status, 503); const value = JSON.parse(response.body);
    assert.equal(value.schema, 'repoing/max-wallet-local-unavailable/1'); assert.equal(value.executionAttempted, undefined); assert.equal(value.outcome, 'unresolved');
    assert.equal(session.uncertain, true); assert.ok(!response.body.includes('secret'));
  } finally { await running.close(); }
});
