// Execute real GET handlers and serializers with disposable DB/RPC adapters, not production services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import * as publicApi from '../../../app/lib/public-api.mjs';
import { transparencyJson } from '../../../app/lib/market-transparency.mjs';
import { parseFeedQuery, readFeedEvents, FEED_KINDS, FeedQueryError } from '../../../src/launch-feed.mjs';
import { publicSchedule } from '../../../src/launch-schedules.mjs';
import { snapshotProfile, sampleSummary } from '../../../src/market-liquidity.mjs';
import { MarketDataClient } from '../dist/index.js';
import { mint, start } from '../examples/tape.mjs';

async function route(path, dependencies) {
  const source = await readFile(new URL(`../../../app/api/v1/${path}/route.js`, import.meta.url), 'utf8');
  const module = new SourceTextModule(source);
  await module.link(specifier => {
    const name = specifier.split('/').at(-1);
    const exports = name === 'public-api.mjs' ? publicApi : name === 'server-timing.mjs'
      ? { withServerTiming: handler => handler } : dependencies[name];
    assert.ok(exports, `Unexpected dependency: ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    });
  });
  await module.evaluate(); return module.namespace;
}
const client = handler => new MarketDataClient({ minIntervalMs: 0, maxRetries: 0,
  fetch: async url => handler(new Request(url), { params: Promise.resolve({ mint }) }) });

test('real launch-event route + query parser + row serializer conform, including newest versus forward order', async () => {
  const rows = ['9007199254740993', '9007199254740994', '9007199254740999'].map(id => ({
    id, githubRepoId: '42', kind: 'market.launched', occurredAt: new Date(start), createdAt: new Date(start + 1), payload: { mint },
  }));
  const db = { async query(sql, params) {
    const forward = sql.includes('id >');
    const result = forward ? rows.filter(row => BigInt(row.id) > BigInt(params[0])) : [...rows].reverse();
    return { rows: result.slice(0, params.at(-1)) };
  } };
  const handler = await route('launches/events', {
    'launch-calendar.mjs': { feedEvents: params => readFeedEvents(db, parseFeedQuery(params)) },
    'launch-feed.mjs': { FEED_KINDS, FeedQueryError },
  });
  const c = client(handler.GET);
  assert.deepEqual((await c.events({ limit: 2 })).events.map(row => row.id), ['9007199254740999', '9007199254740994']);
  const events = [];
  for await (const event of c.iterateEvents({ limit: 2, kinds: ['market.launched'], repos: ['42'] })) events.push(event.id);
  assert.deepEqual(events, ['9007199254740993', '9007199254740994', '9007199254740999']);
  const bad = await handler.GET(new Request('https://repo.ing/api/v1/launches/events?after=-1'));
  assert.equal(bad.status, 400); assert.equal(typeof (await bad.json()).error, 'string');
});

test('real liquidity route serializes both curve and DAMM profiles, null quotes, 404, 429 and 503', async () => {
  for (const venue of ['curve', 'damm']) {
    delete globalThis.__repoingLiveLiquidity;
    const snapshot = { venue, pool: mint, sqrtPrice: 1n << 64n, quoteReserve: venue === 'curve' ? 100_000n : null,
      maxBuyLamports: 10_000n, maxSellBaseUnits: 9000n,
      ...(venue === 'curve' ? { thresholdLamports: 1_000_000n } : {}),
      quote: (direction, amount) => { if (amount > 20_000n) throw new Error('no depth'); return { outputAmount: amount * 99n / 100n, fee: amount / 100n }; },
    };
    let refusal = null, found = true, offline = false;
    const handler = await route('markets/[mint]/liquidity', {
      'server.mjs': { chain: () => ({}), configAddress: () => mint, marketByMint: async () => ({ market: found ? { mint, repoId: '42', symbol: 'TEST' } : null }),
        database: () => ({ query: async () => ({ rows: venue === 'curve' ? [] : [{ pool: mint }] }) }) },
      'request-limits.mjs': { refuseOverLimit: () => refusal },
      'market-liquidity.mjs': { snapshotProfile, sampleSummary,
        curveSnapshot: async () => { if (offline) throw new Error('offline'); return snapshot; },
        dammSnapshot: async () => { if (offline) throw new Error('offline'); return snapshot; } },
      'market-config.mjs': { createMarketConfigResolver: () => () => mint },
      'stock-market-chart.mjs': { isStockMarket: () => false },
      'early-access.mjs': { tradingEarlyAccessConfig: () => ({}) },
    });
    const c = client(handler.GET); const result = await c.liquidity(mint);
    assert.equal(result.liquidity.venue, venue); assert.equal(result.liquidity.sqrtPrice, '18446744073709551616');
    assert.equal(result.liquidity.spreads[0].spreadBps, null);
    assert.equal(result.liquidity.thresholdLamports, venue === 'curve' ? '1000000' : null);
    refusal = new Response(null, { status: 429, headers: { 'Retry-After': '1' } });
    await assert.rejects(c.liquidity(mint), { status: 429 });
    refusal = null; found = false;
    await assert.rejects(client(handler.GET).liquidity(mint), { status: 404 });
    found = true; offline = true; globalThis.__repoingLiveLiquidity.clear();
    await assert.rejects(client(handler.GET).liquidity(mint), { status: 503 });
  }
  delete globalThis.__repoingLiveLiquidity;
});

test('real board and calendar envelopes conform with nullable fields and public schedules', async () => {
  const board = await route('liquidity', { 'launch-calendar.mjs': { liquidityBoard: async () => ({
    generatedAt: new Date(start).toISOString(), markets: [{ repoId: '42', mint, symbol: 'TEST', fullName: 'owner/test',
      sampledAt: new Date(start).toISOString(), venue: 'damm', pool: mint, feeBps: 100, quoteReserveLamports: null,
      buyDepthLamports: '9007199254740993', sellDepthLamports: '0', spreadBps: null, twoSided: false, sustained: null, incentives: null }],
  }) } });
  const value = await client(board.GET).board();
  assert.equal(value.markets[0].buyDepthLamports, '9007199254740993'); assert.equal(value.incentives.paid, false);
  const schedule = publicSchedule({ id: 1, githubRepoId: '42', status: 'scheduled', scheduledAt: new Date(start + 60_000),
    windowMinutes: 15, launcherWallet: mint, maxInitialBuyLamports: 0n, githubLogin: 'maintainer', createdAt: new Date(start) }, start);
  const calendar = await route('launches', { 'launch-calendar.mjs': { calendar: async () => ({
    generatedAt: new Date(start).toISOString(), scheduled: [schedule], groupLaunches: [], recentLaunches: [],
  }) } });
  const launches = await client(calendar.GET).calendar();
  assert.equal(launches.scheduled[0].fullName, null); assert.equal(launches.scheduled[0].maxInitialBuyLamports, '0');
});

test('real transparency route and serializer preserve missing reports and distinguish unavailable markets', async () => {
  let available = true;
  const handler = await route('markets/[mint]/transparency', {
    'server.mjs': { marketByMint: async () => available ? { market: { repoId: '42', mint, pool: mint, symbol: 'TEST' } }
      : { market: null, unavailable: 'offline' } },
    'market-transparency.mjs': { transparencyJson, marketTransparency: async () => ({ report: null, liquidity: null,
      seeded: null, mechanism: { stages: [], notLive: [] }, schedule: null, disclosures: ['Snapshots are not execution promises.'] }) },
  });
  const value = await client(handler.GET).transparency(mint);
  assert.equal(value.report, null); assert.equal(value.market.fullName, null); assert.equal(value.seeded, null);
  available = false;
  await assert.rejects(client(handler.GET).transparency(mint), { status: 503 });
});
