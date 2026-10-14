import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PaperMarketMaker } from '../dist/index.js';
import { snapshot, mint, start } from '../examples/tape.mjs';

const maker = (overrides = {}) => new PaperMarketMaker({ mint, controller: 'owner', relatedControllers: ['treasury'],
  cashLamports: 1_000_000_000n, tokenBaseUnits: 100_000_000n, maxInventoryBaseUnits: 200_000_000n, ...overrides });
const fill = (quote, overrides = {}) => ({ id: 'external-1', quoteId: quote.id, counterpartyController: 'independent-customer',
  tokenBaseUnits: 1_000_003n, now: start + 1, ...overrides });

test('asymmetric two-sided fills use integer prices, conservative rounding, fees and independent accounting', () => {
  const bidMaker = maker(), askMaker = maker();
  const [bid, ask] = bidMaker.update(snapshot(), start);
  assert.equal(bid.side, 'bid'); assert.equal(ask.side, 'ask');
  assert.equal(bid.tokenBaseUnits, 10_204_081n); // 1% of 1 SOL / 0.98 lamports per base unit
  assert.equal(ask.tokenBaseUnits, 8_000_000n); // 1% of sell-side depth, not buy depth
  assert.ok(bid.priceNumerator < ask.priceNumerator);
  bid.tokenBaseUnits = 999_999_999n; // public copies cannot mutate reservations
  assert.equal(bidMaker.quotes[0].tokenBaseUnits, 10_204_081n);
  const bought = bidMaker.fill(fill(bid));
  assert.equal(bought.notionalLamports, 980_003n); assert.equal(bought.feeLamports, 9801n);
  assert.equal(bought.cashLamports, 999_010_196n); assert.equal(bought.tokenBaseUnits, 101_000_003n);
  assert.equal(bought.pnlLamports, 10_199n);
  const sell = askMaker.update(snapshot(), start).find(row => row.side === 'ask');
  const sold = askMaker.fill(fill(sell));
  assert.equal(sold.notionalLamports, 1_020_003n); assert.equal(sold.feeLamports, 10_201n);
  assert.equal(sold.cashLamports, 1_001_009_802n); assert.equal(sold.tokenBaseUnits, 98_999_997n);
  assert.equal(sold.pnlLamports, 9799n);
  assert.deepEqual(bidMaker.quotes, []); assert.deepEqual(askMaker.quotes, []);
  assert.throws(() => bidMaker.fill(fill(ask, { id: 'other' })), /not active/);
});

test('self/related trades, duplicates, oversize fills and negative inventory are prohibited', () => {
  const m = maker(); const quotes = m.update(snapshot(), start); const before = m.metrics;
  for (const controller of ['owner', 'treasury', '']) assert.throws(() => m.fill(fill(quotes[0], { counterpartyController: controller })), /prohibited/);
  assert.throws(() => m.fill(fill(quotes[0], { tokenBaseUnits: quotes[0].tokenBaseUnits + 1n })), /exceeds/);
  assert.deepEqual(m.metrics, before);
  m.fill(fill(quotes[0])); m.update(snapshot(1), start + 15_000);
  assert.throws(() => m.fill(fill(m.quotes[0], { now: start + 15_001 })), /unique/);
  assert.equal(maker({ tokenBaseUnits: 0n }).update(snapshot(), start).some(q => q.side === 'ask'), false);
  assert.equal(maker({ tokenBaseUnits: 200_000_000n }).update(snapshot(), start).some(q => q.side === 'bid'), false);
  assert.equal(maker({ cashLamports: 0n }).update(snapshot(), start).some(q => q.side === 'bid'), false);
});

test('expiry, stale/future/wrong-market data and drawdown latch the kill switch', () => {
  assert.equal(maker().update(snapshot(), start + 44_999).length, 2);
  assert.equal(maker().update(snapshot(), start - 5000).length, 2);
  assert.throws(() => maker().update(snapshot(), start - 5001), /future/);
  for (const delta of [-1, 45_000, 45_001]) {
    const m = maker(); m.update(snapshot(), start);
    assert.throws(() => m.update(snapshot(), start + delta)); assert.deepEqual(m.quotes, []);
    assert.ok(m.metrics.stopped); assert.throws(() => m.update(snapshot(1), start + 60_000));
  }
  const m = maker(); const quotes = m.update(snapshot(), start);
  assert.throws(() => m.fill(fill(quotes[0], { now: start + 45_000 })), /expired/);
  assert.deepEqual(m.quotes, []);
  const wrong = snapshot(); wrong.market.mint = '11111111111111111111111111111111';
  assert.throws(() => maker().update(wrong, start), /Wrong market/);
  const loss = maker({ maxDrawdownLamports: 50_000_000n }); loss.update(snapshot(), start);
  const crash = snapshot(1); crash.liquidity.sqrtPrice = '9223372036854775808'; // 1/4 previous price
  assert.deepEqual(loss.update(crash, start + 15_000), []); assert.equal(loss.metrics.stopped, 'drawdown limit');
});

test('cash and cumulative turnover budgets apply at their boundaries, not per replacement', () => {
  const m = maker({ maxTurnoverLamports: 980_003n });
  const bid = m.update(snapshot(), start)[0];
  m.fill(fill(bid)); assert.equal(m.metrics.stopped, 'session budget exhausted');
  assert.throws(() => m.update(snapshot(1), start + 15_000), /stopped/);
  const small = maker({ cashLamports: 9900n });
  const q = small.update(snapshot(), start)[0];
  small.fill(fill(q, { tokenBaseUnits: q.tokenBaseUnits }));
  assert.ok(small.metrics.cashLamports >= 0n);
  assert.throws(() => maker({ maxQuoteLamports: 100_000_001n }), /risk limit/);
});

test('default example is deterministic and rejects live execution options', () => {
  const run = (...args) => spawnSync(process.execPath, ['examples/two-sided.mjs', ...args], { encoding: 'utf8' });
  const first = run(), second = run();
  assert.equal(first.status, 0, first.stderr); assert.equal(second.stdout, first.stdout);
  const lines = first.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].mode, 'simulation'); assert.equal(lines[0].execution, 'disabled');
  assert.equal(lines.at(-1).paper.fills, 5); assert.equal(lines.at(-1).paper.turnoverLamports, '5100015');
  assert.equal(run('--live').status, 1); assert.equal(run('--ticks=11').status, 1);
});
