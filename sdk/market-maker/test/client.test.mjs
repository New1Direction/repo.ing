import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketDataClient, API_VERSION } from '../dist/index.js';
import { snapshot, mint, start } from '../examples/tape.mjs';

const headers = { 'content-type': 'application/json', 'x-repoing-api-version': API_VERSION };
const json = value => new Response(JSON.stringify(value), { headers });
const client = (fetch, options = {}) => new MarketDataClient({ fetch, minIntervalMs: 0, ...options });
const event = id => ({ id, repoId: '1', kind: 'market.launched', occurredAt: '2026-10-14T00:00:00Z', recordedAt: '2026-10-14T00:00:01Z', data: {} });

test('network is opt-in, origins cannot carry credentials, every wire read is GET-only', async () => {
  assert.throws(() => new MarketDataClient(), /Network disabled/);
  for (const baseUrl of ['http://repo.ing', 'https://user:password@repo.ing', 'https://repo.ing/api', 'https://repo.ing?key=x']) {
    assert.throws(() => client(() => {}, { baseUrl }), /HTTPS origin/);
  }
  const c = client(async (url, options) => {
    assert.equal(url, `https://repo.ing/api/v1/markets/${mint}/liquidity`);
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    return json(snapshot());
  });
  assert.equal((await c.liquidity(mint)).liquidity.sqrtPrice, '18446744073709551616');
  assert.throws(() => c.liquidity('../trade'), /Invalid/);
});

test('forward pagination keeps filters and bigint IDs, ignores next URLs, and drains short pages', async () => {
  const pages = [['9007199254740993', '9007199254740998'], ['9007199254741001'], []];
  const cursors = [];
  const c = client(async url => {
    const params = new URL(url).searchParams;
    cursors.push(params.get('after'));
    assert.equal(params.get('kind'), 'market.launched'); assert.equal(params.get('repo'), '1'); assert.equal(params.get('limit'), '2');
    return json({ events: pages.shift().map(event), kinds: [], next: 'https://untrusted.invalid/?after=0' });
  });
  const seen = [];
  for await (const row of c.iterateEvents({ after: '9007199254740992', limit: 2, kinds: ['market.launched'], repos: ['1'] })) seen.push(row.id);
  assert.deepEqual(seen, ['9007199254740993', '9007199254740998', '9007199254741001']);
  assert.deepEqual(cursors, ['9007199254740992', '9007199254740998', '9007199254741001']);
  for (const ids of [['2', '2'], ['2', '1'], ['0']]) {
    const broken = client(async () => json({ events: ids.map(event), kinds: [], next: null }));
    await assert.rejects(broken.iterateEvents().next(), { code: 'contract' });
  }
  const endless = client(async () => json({ events: [event('1')], kinds: [], next: null })).iterateEvents({ maxPages: 1 });
  assert.equal((await endless.next()).value.id, '1');
  await assert.rejects(endless.next(), { code: 'limit' });
});

test('429 Retry-After is respected across concurrent calls, with bounded transient retries', async () => {
  const calls = [], observations = [];
  const c = client(async () => {
    calls.push(Date.now());
    return calls.length === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '0.6' } }) : json(snapshot());
  }, { observe: row => observations.push(row) });
  await Promise.all([c.liquidity(mint), c.liquidity(mint)]);
  assert.ok(calls[1] - calls[0] >= 590);
  assert.deepEqual(c.metrics, { requests: 3, retries: 1, errors: 0, snapshots: 0 });
  assert.ok(observations.find(row => row.event === 'retry' && row.status === 429 && row.delayMs >= 600));
  let attempts = 0;
  const flaky = client(async () => { if (++attempts === 1) throw new TypeError('transport'); return json(snapshot()); });
  await flaky.liquidity(mint); assert.equal(attempts, 2);
  const exhausted = client(async () => new Response(null, { status: 503 }), { maxRetries: 1 });
  await assert.rejects(exhausted.liquidity(mint), { code: 'http', status: 503 });
  assert.equal(exhausted.metrics.requests, 2);
});

test('deadline includes queue, body, Retry-After HTTP dates and overflow-sized delays', async () => {
  for (const value of [new Date(Date.now() + 60_000).toUTCString(), '99999999999999999999999999999']) {
    const c = client(async () => new Response(null, { status: 429, headers: { 'retry-after': value } }), { timeoutMs: 40 });
    await assert.rejects(c.liquidity(mint), { code: 'timeout' });
    assert.equal(c.metrics.requests, 1);
  }
  let calls = 0;
  const stuck = client(async () => { calls++; return new Response(new ReadableStream({ start() {} }), { headers }); }, { timeoutMs: 40 });
  const queuedAbort = new AbortController();
  const one = stuck.liquidity(mint), two = stuck.liquidity(mint, { signal: queuedAbort.signal });
  queuedAbort.abort();
  await assert.rejects(two, { code: 'aborted' }); await assert.rejects(one, { code: 'timeout' });
  assert.equal(calls, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(stuck.liquidity(mint, { signal: abort.signal }), { code: 'aborted' });
  assert.equal(calls, 1);
});

test('permanent HTTP, version drift, malformed data and oversized bodies fail closed without retries', async () => {
  const wrongMint = snapshot(); wrongMint.market.mint = '11111111111111111111111111111111';
  const unsafeAmount = snapshot(); unsafeAmount.liquidity.sqrtPrice = 18446744073709551616;
  const cases = [
    [() => new Response(null, { status: 404 }), 'http'],
    [() => new Response('{}', { headers: { ...headers, 'x-repoing-api-version': 'tomorrow' } }), 'contract'],
    [() => new Response('not-json', { headers }), 'contract'],
    [() => json(wrongMint), 'contract'], [() => json(unsafeAmount), 'contract'],
    [() => json(snapshot()), 'limit', { maxResponseBytes: 40 }],
  ];
  for (const [response, code, options] of cases) {
    const c = client(async () => response(), options);
    await assert.rejects(c.liquidity(mint), { code }); assert.equal(c.metrics.requests, 1);
  }
  const c = client(async () => json(snapshot()), { observe() { throw new Error('logger broken'); } });
  assert.equal((await c.liquidity(mint)).market.mint, mint);
});

test('polling enforces freshness and cancellation; consumers can close without extra requests', async () => {
  const stale = client(async () => json(snapshot()));
  await assert.rejects(stale.watchLiquidity(mint).next(), { code: 'stale' });
  const fresh = snapshot(); fresh.liquidity.checkedAt = new Date().toISOString();
  const c = client(async () => json(fresh));
  const controller = new AbortController();
  const stream = c.watchLiquidity(mint, { signal: controller.signal });
  assert.equal((await stream.next()).value.market.mint, mint);
  const pending = stream.next(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(c.metrics.requests, 1);
  const once = c.watchLiquidity(mint); await once.next(); await once.return();
  assert.equal(c.metrics.requests, 2);
});

test('polling suppresses cached snapshots and rejects timestamp regression under backpressure', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const tape = [snapshot(0), snapshot(0), snapshot(1), snapshot(0)];
  const c = client(async () => json(tape.shift()));
  const stream = c.watchLiquidity(mint, { intervalMs: 10_000 });
  const flush = async () => { for (let i = 0; i < 15; i++) { t.mock.timers.tick(0); await new Promise(setImmediate); } };
  const first = stream.next(); await flush(); await first;
  assert.equal(c.metrics.requests, 1);
  t.mock.timers.tick(10_000); await flush(); // No next() means no background polling.
  assert.equal(c.metrics.requests, 1);
  let yielded = false;
  const second = stream.next().then(value => { yielded = true; return value; });
  t.mock.timers.tick(10_000); await flush();
  assert.equal(c.metrics.requests, 2); assert.equal(yielded, false);
  t.mock.timers.tick(10_000); await flush();
  assert.equal((await second).value.liquidity.checkedAt, snapshot(1).liquidity.checkedAt);
  const regression = assert.rejects(stream.next(), { code: 'stale' });
  t.mock.timers.tick(10_000); await flush(); await regression;
  assert.equal(c.metrics.snapshots, 2);
});
