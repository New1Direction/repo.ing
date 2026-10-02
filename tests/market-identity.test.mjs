import test from 'node:test'
import assert from 'node:assert/strict'
import { GITHUB_REPO_ID_MAX, HF_MARKET_REF_MAX, HF_MARKET_REF_MIN, MarketIdentityError, assertAuthoritySource, assertGithubRepoId,
  assertHfMarketId, isGithubRepoId, isMarketId, marketSource } from '../src/market-identity.mjs'
import { TIP_WALLET_LOCK } from '../src/tip-transfers.mjs'
import { PARTS_PLEDGE_LOCK } from '../src/parts-pledges.mjs'

const TWO_52 = 2n ** 52n
const forms = value => [value, Number(value), value.toString()]

test('ranges: GitHub below 2^52, Hugging Face 2^52+1 through 7e15, exact as Numbers and clear of fixed lock keys', () => {
  assert.equal(GITHUB_REPO_ID_MAX, TWO_52 - 1n)
  assert.equal(HF_MARKET_REF_MIN, TWO_52 + 1n)
  assert.equal(HF_MARKET_REF_MAX, 7_000_000_000_000_000n)
  assert.ok(HF_MARKET_REF_MAX < 2n ** 53n && Number.isSafeInteger(Number(HF_MARKET_REF_MAX)))
  // Single-bigint advisory locks share one keyspace with the per-repository locks taken on market ids.
  for (const lock of [TIP_WALLET_LOCK, PARTS_PLEDGE_LOCK]) assert.ok(BigInt(lock) > HF_MARKET_REF_MAX, lock)
})

test('every boundary classifies the same as a bigint, a number and a decimal string', () => {
  const cases = [[1n, 'github'], [1384142609n, 'github'], [GITHUB_REPO_ID_MAX, 'github'],
    [HF_MARKET_REF_MIN, 'huggingface'], [HF_MARKET_REF_MIN + 1n, 'huggingface'], [HF_MARKET_REF_MAX, 'huggingface']]
  for (const [value, source] of cases) {
    for (const id of forms(value)) {
      assert.equal(marketSource(id), source, `${typeof id} ${id}`)
      assert.equal(isMarketId(id), true)
      assert.equal(isGithubRepoId(id), source === 'github')
    }
  }
  assert.equal(marketSource('0042'), 'github', 'leading zeros are the same integer')
})

test('ids outside both ranges throw, including 2^52 itself', () => {
  for (const value of [0n, -1n, TWO_52, HF_MARKET_REF_MAX + 1n, 2n ** 53n - 1n]) {
    for (const id of forms(value)) {
      assert.throws(() => marketSource(id), MarketIdentityError, `${typeof id} ${id}`)
      assert.equal(isMarketId(id), false)
      assert.equal(isGithubRepoId(id), false)
    }
  }
  assert.throws(() => marketSource(2n ** 64n), MarketIdentityError)
  assert.throws(() => marketSource('0'.repeat(20)), /outside every source range/)
})

test('garbage never parses as a market id', () => {
  const garbage = [null, undefined, '', ' 1', '1 ', '+1', '-1', '1.0', '1e3', '0x10', '1n', '١٢٣', '9'.repeat(21), 1.5, -0.5, NaN,
    Infinity, -Infinity, 2 ** 53, Number.MAX_SAFE_INTEGER + 2, {}, [], [1], true, false, Object('1'), Symbol('1'), () => 1]
  for (const id of garbage) {
    assert.throws(() => marketSource(id), MarketIdentityError, String(typeof id === 'symbol' ? 'symbol' : id))
    assert.equal(isMarketId(id), false)
    assert.equal(isGithubRepoId(id), false)
  }
})

test('assertGithubRepoId and assertHfMarketId accept only their own range and return a bigint', () => {
  for (const id of forms(1384142609n)) assert.equal(assertGithubRepoId(id), 1384142609n)
  for (const id of forms(HF_MARKET_REF_MIN)) assert.equal(assertHfMarketId(id), HF_MARKET_REF_MIN)
  for (const id of [...forms(HF_MARKET_REF_MIN), ...forms(HF_MARKET_REF_MAX), 0n, TWO_52, 'abc', null]) {
    assert.throws(() => assertGithubRepoId(id), MarketIdentityError)
  }
  for (const id of [...forms(1n), ...forms(GITHUB_REPO_ID_MAX), TWO_52, HF_MARKET_REF_MAX + 1n, 'abc', undefined]) {
    assert.throws(() => assertHfMarketId(id), MarketIdentityError)
  }
  assert.throws(() => assertGithubRepoId(HF_MARKET_REF_MIN), /Not a GitHub repository ID/)
})

test('an authority acts only for markets of its own source; one without a source is GitHub', () => {
  for (const authority of [undefined, null, {}, { verifyCurrentAuthority() {} }, { source: 'github' }]) {
    assert.doesNotThrow(() => assertAuthoritySource(authority, 1384142609n))
    assert.throws(() => assertAuthoritySource(authority, HF_MARKET_REF_MIN), /github authority cannot act for a huggingface market/)
  }
  assert.doesNotThrow(() => assertAuthoritySource({ source: 'huggingface' }, HF_MARKET_REF_MAX))
  assert.throws(() => assertAuthoritySource({ source: 'huggingface' }, '1384142609'), /huggingface authority cannot act for a github market/)
  for (const source of ['GitHub', 'hf', '']) assert.throws(() => assertAuthoritySource({ source }, 1n), MarketIdentityError)
  assert.throws(() => assertAuthoritySource({ source: 'github' }, TWO_52), /outside every source range/)
})
