/**
 * Actual local-runner browser check. No page.route, canned outcomes, or mocked VM.
 * Run against a fresh opt-in runner:
 * MAX_WALLET_LOCAL_URL=http://127.0.0.1:PORT CHROMIUM_PATH=/usr/bin/chromium \
 *   node --test spikes/hook-playground/max-wallet-flow.browser.test.mjs
 * Optional fixture amounts: MW_TEST_VIRTUAL_QUOTE, MW_TEST_BUY, MW_TEST_SELL,
 * MW_TEST_CAP_FAIL_BUY. The UI itself has no defaults for any of these amounts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const baseURL = process.env.MAX_WALLET_LOCAL_URL;

test('actual loopback prepare, launch, buy, sell, pre-execution rejections and separate simulation', { skip: !baseURL, timeout: 300000 }, async () => {
  const parsed = new URL(baseURL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'Use only the explicit loopback runner.');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [], outbound = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== parsed.origin) outbound.push(request.url()); });
  const perform = async (selector, path, action, expectedStatus = 200) => {
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST' && response.request().postDataJSON()?.action === action, { timeout: 120000 });
    await page.locator(selector).click();
    const response = await responsePromise;
    const body = await response.json();
    assert.equal(response.status(), expectedStatus, `${action} HTTP status: ${JSON.stringify(body)}`);
    assert.equal(body.canSign, false); assert.equal(body.canSubmit, false);
    return body;
  };
  const reviewExecute = async (selector, action, expectedOutcome = 'succeeded') => {
    const review = await perform(selector, '/__local/max-wallet/review', action);
    await expect(page.locator('#mw-review-panel')).toBeVisible();
    await expect(page.locator('#mw-review-details')).toContainText(review.messageSha256);
    const result = await perform('#mw-execute', '/__local/max-wallet/action', action);
    assert.equal(result.outcome, expectedOutcome, JSON.stringify(result));
    assert.equal(result.messageSha256, review.messageSha256);
    assert.equal(result.state.revision, review.revision + 1);
    await expect(page.locator('#mw-balance-base')).toHaveText(result.state.balances.traderBaseRaw);
    await expect(page.locator('#mw-balance-quote')).toHaveText(result.state.balances.traderQuoteRaw);
    await expect(page.locator('#mw-receipts li').first()).toContainText(result.requestId);
    return result;
  };
  const fillTrade = async (direction, amount, minimum = '1') => {
    await page.locator('#mw-direction').selectOption(direction);
    await page.locator('#mw-amount-in').fill(amount);
    await page.locator('#mw-min-out').fill(minimum);
    const quote = await perform('#mw-get-quote', '/__local/max-wallet/action', 'quote');
    assert.equal(quote.outcome, 'quoted'); assert.equal(quote.messageSha256, null);
    await expect(page.locator('#mw-review-trade')).toBeEnabled();
    return quote;
  };
  try {
    await page.goto(baseURL);
    await expect(page.locator('#startup-error')).toBeHidden();
    await expect(page.locator('#save-status')).toHaveText('Saved on this browser');
    const originalStorage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    const originalScenario = await page.locator('#scenario-name').textContent();
    await page.locator('#max-wallet-local-open').click();
    await expect(page.locator('#mw-phase')).toContainText('unprepared');
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#max-wallet-local-workspace')).toContainText('Signatures not verified. No real wallet.');
    for (const id of ['mw-cap-bps', 'mw-label', 'mw-name', 'mw-symbol', 'mw-uri', 'mw-virtual-quote', 'mw-amount-in', 'mw-min-out']) await expect(page.locator(`#${id}`)).toHaveValue('');
    await page.locator('#mw-cap-bps').fill('100'); await page.locator('#mw-label').fill('Browser program test');
    // A cancelled exact review executes nothing and can be deliberately rebuilt.
    await perform('#mw-review-prepare', '/__local/max-wallet/review', 'prepare');
    await page.locator('#mw-cancel-review').click();
    await expect(page.locator('#mw-status')).toContainText('Review cancelled');
    await expect(page.locator('#mw-no-receipts')).toBeVisible();
    const preparation = await reviewExecute('#mw-review-prepare', 'prepare');
    const originalIdentities = preparation.state.identities;
    await expect(page.locator('#mw-phase')).toContainText('prepared');
    await page.locator('#mw-name').fill('Browser local test'); await page.locator('#mw-symbol').fill('BTEST');
    await page.locator('#mw-virtual-quote').fill(process.env.MW_TEST_VIRTUAL_QUOTE || '1000000000');
    await reviewExecute('#mw-review-launch', 'launch');
    await expect(page.locator('#mw-phase')).toContainText('launched');
    const buyAmount = process.env.MW_TEST_BUY || '1000000', sellAmount = process.env.MW_TEST_SELL || '1000000000';
    await fillTrade('buy', buyAmount);
    // Editing any amount invalidates a quote without sending an action.
    await page.locator('#mw-min-out').fill('2'); await expect(page.locator('#mw-review-trade')).toBeDisabled();
    await page.locator('#mw-min-out').fill('1'); await perform('#mw-get-quote', '/__local/max-wallet/action', 'quote');
    const buy = await reviewExecute('#mw-review-trade', 'buy'); assert.ok(BigInt(buy.state.balances.traderBaseRaw) > 0n);
    await fillTrade('sell', sellAmount); const sell = await reviewExecute('#mw-review-trade', 'sell');
    assert.ok(BigInt(sell.state.balances.traderBaseRaw) < BigInt(buy.state.balances.traderBaseRaw));
    const expectPreExecutionFailure = async (selector, action, balances, revision) => {
      const receiptCount = await page.locator('#mw-receipts li').count();
      const rejected = await perform(selector, '/__local/max-wallet/' + (action === 'quote' ? 'action' : 'review'), action, 422);
      assert.equal(rejected.schema, 'repoing/max-wallet-local-error/1');
      assert.equal(rejected.executionAttempted, false);
      await expect(page.locator('#mw-error')).toBeFocused();
      await expect(page.locator('#mw-status')).toContainText(`revision ${revision}`);
      await expect(page.locator('#mw-balance-base')).toHaveText(balances.traderBaseRaw);
      await expect(page.locator('#mw-balance-quote')).toHaveText(balances.traderQuoteRaw);
      assert.equal(await page.locator('#mw-receipts li').count(), receiptCount);
      return rejected;
    };
    await fillTrade('buy', process.env.MW_TEST_CAP_FAIL_BUY || '20000000');
    const capFailure = await expectPreExecutionFailure('#mw-review-trade', 'buy', sell.state.balances, sell.state.revision);
    assert.match(capFailure.error, /cap/i);
    // Deliberately require more output than the non-executing quote returns.
    // Normal safety preflight must reject this before SBF execution.
    const quote = await fillTrade('buy', buyAmount);
    await fillTrade('buy', buyAmount, (BigInt(quote.quote.amountOutRaw) + 1n).toString());
    const slippageFailure = await expectPreExecutionFailure('#mw-review-trade', 'buy', sell.state.balances, sell.state.revision);
    assert.match(slippageFailure.error, /minimum output|liquidity/i);
    const paused = await perform('#mw-toggle-pause', '/__local/max-wallet/action', 'pause');
    assert.equal(paused.messageSha256, null); assert.equal(paused.state.phase, 'paused');
    await page.locator('#mw-min-out').fill('1');
    const pausedFailure = await expectPreExecutionFailure('#mw-get-quote', 'quote', paused.state.balances, paused.state.revision);
    assert.match(pausedFailure.error, /paused/i);
    const resumed = await perform('#mw-toggle-pause', '/__local/max-wallet/action', 'pause');
    assert.equal(resumed.state.phase, 'launched');
    assert.deepEqual(resumed.state.identities, originalIdentities);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(accessibility.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), []);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Horizontal overflow at ${width}px`);
    }
    if (process.env.MW_TEST_SCREENSHOT) await page.screenshot({ path: process.env.MW_TEST_SCREENSHOT, fullPage: true });
    await page.locator('#mw-back').click();
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#max-wallet-local-workspace')).toBeHidden();
    assert.equal(await page.locator('#scenario-name').textContent(), originalScenario);
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))), originalStorage);
    assert.deepEqual(errors, []); assert.deepEqual(outbound, []);
  } finally { await context.close(); await browser.close(); }
});
