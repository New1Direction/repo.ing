import test from 'node:test'
import assert from 'node:assert/strict'
import { solUsdPrice } from '../app/lib/sol-usd.mjs'

// Own file: sol-usd keeps one process-wide price, so this sequence of clock values must not share state with other tests.
const answer = usd => async () => ({ ok: true, json: async () => ({ solana: { usd } }) })

test('a valid SOL price is refreshed in the background during its last minute, so no request waits on the sources', async () => {
  assert.equal(await solUsdPrice(answer(150), 0), 150)
  // Mid-window: cached, no source call.
  let calls = 0
  const counting = usd => async () => { calls++; return answer(usd)() }
  assert.equal(await solUsdPrice(counting(151), 200_000), 150)
  assert.equal(calls, 0)
  // Last minute of the 5-minute window: the old price is returned immediately while one refresh starts.
  let release
  const slow = async () => { calls++; await new Promise(resolve => { release = resolve }); return answer(152)() }
  assert.equal(await solUsdPrice(slow, 250_000), 150)
  assert.equal(await solUsdPrice(slow, 251_000), 150)
  assert.equal(calls, 1, 'one background refresh, however many requests arrive')
  release()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(await solUsdPrice(counting(999), 260_000), 152)
  assert.equal(calls, 1)
})

test('a failed background refresh keeps the valid price until it expires, then serves none (never an expired price)', async () => {
  // Current price 152 was loaded at 250 000 and expires at 550 000.
  const down = async () => ({ ok: false })
  assert.equal(await solUsdPrice(down, 500_000), 152)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(await solUsdPrice(down, 520_000), 152, 'still valid; the failed refresh backs off')
  assert.equal(await solUsdPrice(down, 550_000), null, 'expired and sources still failing: no stale price')
})
