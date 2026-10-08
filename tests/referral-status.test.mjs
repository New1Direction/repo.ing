import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { loadReferralStatus, peekReferralStatus, readShareReferralChoice, REFERRAL_STATUS_TTL_MS, setReferralStatus, SHARE_REFERRAL_KEY,
  shareReferral, subscribeReferralStatus, writeShareReferralChoice } from '../app/lib/referral-status.mjs'
import { tokenPageUrl } from '../app/lib/share-links.mjs'

const wallet = () => Keypair.generate().publicKey.toBase58()
const enabled = { enabled: true, earningsLamports: '0', setupLamports: '2039280' }

test('a share carries ?ref only for a wallet with payouts set up, and only while the sharer keeps it on', () => {
  const owner = wallet()
  assert.equal(shareReferral({ wallet: owner, status: enabled, include: true }), owner)
  for (const [status, include] of [[enabled, false], [{ ...enabled, enabled: false }, true], [null, true], [false, true]]) {
    assert.equal(shareReferral({ wallet: owner, status, include }), null, JSON.stringify({ status, include }))
  }
  assert.equal(shareReferral({ wallet: null, status: enabled, include: true }), null)
  // Without a ref the market link is the plain public one.
  assert.equal(tokenPageUrl('M', 'https://repo.ing', shareReferral({ wallet: owner, status: null, include: true })), 'https://repo.ing/token/M')
})

test('the include-referral choice is remembered per browser and defaults to on; blocked storage never throws', () => {
  const store = new Map(), storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  assert.equal(readShareReferralChoice(storage), true)
  writeShareReferralChoice(storage, false)
  assert.equal(store.get(SHARE_REFERRAL_KEY), 'off')
  assert.equal(readShareReferralChoice(storage), false)
  writeShareReferralChoice(storage, true)
  assert.equal(readShareReferralChoice(storage), true)
  const blocked = { getItem: () => { throw Error('blocked') }, setItem: () => { throw Error('blocked') } }
  assert.equal(readShareReferralChoice(blocked), true)
  assert.doesNotThrow(() => writeShareReferralChoice(blocked, false))
  assert.equal(readShareReferralChoice(null), true)
})

test('payout status is read once per wallet per minute and shared; setup completion reaches every subscriber', async () => {
  const owner = wallet(), calls = []
  let clock = 1_000
  const fetcher = async url => { calls.push(url); return { ok: true, json: async () => ({ enabled: false, earningsLamports: '0', setupLamports: '2039280' }) } }
  const [first, second] = await Promise.all([loadReferralStatus(owner, { fetcher, now: () => clock }), loadReferralStatus(owner, { fetcher, now: () => clock })])
  assert.deepEqual(first, { enabled: false, earningsLamports: '0', setupLamports: '2039280', free: false })
  assert.equal(second, first)
  await loadReferralStatus(owner, { fetcher, now: () => clock + REFERRAL_STATUS_TTL_MS - 1 })
  assert.deepEqual(calls, [`/api/referral?wallet=${owner}`], 'concurrent and fresh reads share one request')
  const seen = []
  const stop = subscribeReferralStatus(owner, value => seen.push(value))
  setReferralStatus(owner, { ...first, enabled: true }, clock)
  stop()
  setReferralStatus(owner, { ...first, enabled: false }, clock)
  assert.deepEqual(seen, [{ ...first, enabled: true }])
  assert.equal(peekReferralStatus(owner).enabled, false)
  clock += 10 * REFERRAL_STATUS_TTL_MS
  await loadReferralStatus(owner, { fetcher, now: () => clock })
  assert.equal(calls.length, 2, 'stale after a minute')
})

test('an unreadable status is false (no ref is added), never an error', async () => {
  for (const fetcher of [async () => { throw Error('offline') }, async () => ({ ok: false, json: async () => ({ error: 'x' }) }),
    async () => ({ ok: true, json: async () => ({ enabled: 'yes' }) })]) {
    const owner = wallet()
    assert.equal(await loadReferralStatus(owner, { fetcher }), false)
    assert.equal(shareReferral({ wallet: owner, status: peekReferralStatus(owner), include: true }), null)
  }
})
