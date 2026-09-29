import test from 'node:test'
import assert from 'node:assert/strict'
import { RETURN_MAX, RETURN_MIN, formatReturn, parseReturnParam, returnPageUrl, returnParam, returnShareText, sharedReturn, xReturnShareUrl } from '../app/lib/share-links.mjs'

const MINT = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'

test('shared return rounds to one decimal and clamps to the card bounds', () => {
  assert.equal(sharedReturn(42.14), 42.1)
  assert.equal(sharedReturn(42.16), 42.2)
  assert.equal(sharedReturn(-12.34), -12.3)
  assert.equal(sharedReturn(-100), RETURN_MIN)
  assert.equal(sharedReturn(1e9), RETURN_MAX)
  assert.ok(Object.is(sharedReturn(-0.04), 0))
  for (const bad of [null, undefined, '', NaN, Infinity, 'abc']) assert.equal(sharedReturn(bad), null)
})

test('return param parsing accepts only the canonical bounded form', () => {
  for (const [raw, pct] of [['42.1', 42.1], ['-12.3', -12.3], ['0.0', 0], ['-99.9', -99.9], ['100000.0', 100000]]) {
    assert.equal(parseReturnParam(raw), pct)
    assert.equal(returnParam(pct), raw)
  }
  for (const bad of ['42', '42.10', '042.1', '+42.1', '-0.0', '-100.0', '100000.1', '999999.9', '1e3', '42.1x', ' 42.1', '', undefined, 42.1]) {
    assert.equal(parseReturnParam(bad), null, String(bad))
  }
})

test('returns format signed with one decimal', () => {
  assert.equal(formatReturn(42.1), '+42.1%')
  assert.equal(formatReturn(-12.3), '-12.3%')
  assert.equal(formatReturn(0), '0.0%')
  assert.equal(formatReturn(100000), '+100,000.0%')
})

test('return share carries only the market and percentage, never wallet, SOL or size', () => {
  assert.equal(returnShareText({ symbol: 'DENO', fullName: 'denoland/deno', pct: 42.1 }), "+42.1% on $DENO (denoland/deno) — every trade pays the repo's builders @repodoting")
  assert.equal(returnShareText({ pct: -5 }), "-5.0% on an open source repo — every trade pays the repo's builders @repodoting")
  const url = new URL(xReturnShareUrl({ mint: MINT, symbol: 'DENO', fullName: 'denoland/deno', percent: 42.137 }))
  assert.equal(url.origin + url.pathname, 'https://x.com/intent/post')
  assert.deepEqual([...url.searchParams.keys()], ['text', 'url'])
  assert.equal(url.searchParams.get('url'), `https://repo.ing/token/${MINT}/return/42.1`)
  assert.equal(returnPageUrl(MINT, -99.9), `https://repo.ing/token/${MINT}/return/-99.9`)
  assert.doesNotMatch(url.toString(), /SOL|lamport|wallet/i)
})

test('no share link without a mint or a percentage', () => {
  assert.equal(xReturnShareUrl({ mint: MINT, percent: null }), null)
  assert.equal(xReturnShareUrl({ percent: 10 }), null)
})
