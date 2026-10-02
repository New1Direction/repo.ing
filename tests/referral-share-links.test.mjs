import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { captionWithReferral, tokenPageUrl, withReferral, xReturnShareUrl, xShareUrl } from '../app/lib/share-links.mjs'
import { dialToUrl, sellApiPath } from '../app/lib/blink-links.mjs'
import { captureReferral, siteReferralLink, storedReferral } from '../app/lib/referral.mjs'
import { payoutShare } from '../src/market-share.mjs'

const MINT = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const wallet = Keypair.generate().publicKey.toBase58()
const NOT_WALLETS = [null, undefined, '', 'nonsense', `${wallet}xx`, 42, { toString: () => wallet }]

test('a connected wallet\'s token links carry ?ref=<wallet>; anything else leaves the link untouched', () => {
  assert.equal(tokenPageUrl(MINT, 'https://repo.ing', wallet), `https://repo.ing/token/${MINT}?ref=${wallet}`)
  assert.equal(tokenPageUrl(MINT, 'http://localhost:3001', wallet), `http://localhost:3001/token/${MINT}?ref=${wallet}`)
  for (const ref of NOT_WALLETS) assert.equal(tokenPageUrl(MINT, 'https://repo.ing', ref), `https://repo.ing/token/${MINT}`, String(ref))
  assert.equal(withReferral(`https://repo.ing/token/${MINT}?ref=old`, wallet), `https://repo.ing/token/${MINT}?ref=${wallet}`, 'one ref, the sharer\'s')
})

test('X posts link the market with the sharer\'s ref and nothing else about the wallet', () => {
  const url = new URL(xShareUrl({ mint: MINT, fullName: 'vercel/next.js', symbol: 'NEXT', kind: 'buy', ref: wallet }))
  assert.deepEqual([...url.searchParams.keys()], ['text', 'url'])
  assert.equal(url.searchParams.get('url'), `https://repo.ing/token/${MINT}?ref=${wallet}`)
  assert.doesNotMatch(url.searchParams.get('text'), new RegExp(wallet))
  assert.equal(new URL(xShareUrl({ mint: MINT, kind: 'launch', ref: 'bad' })).searchParams.get('url'), `https://repo.ing/token/${MINT}`)
  // A shared return stays wallet-free: it would tie the sharer's P&L to their address.
  assert.doesNotMatch(xReturnShareUrl({ mint: MINT, percent: 12.3, ref: wallet }), new RegExp(wallet))
})

test('Blink links carry the ref into the action URL that dial.to and wallets fetch', () => {
  const link = new URL(dialToUrl(MINT, 'https://repo.ing', wallet))
  assert.equal(link.origin + link.pathname, 'https://dial.to/')
  assert.equal(link.searchParams.get('action'), `solana-action:https://repo.ing/api/actions/buy/${MINT}?ref=${wallet}`)
  assert.equal(dialToUrl(MINT, 'https://repo.ing', 'bad'), dialToUrl(MINT))
  assert.equal(sellApiPath(MINT), `/api/actions/sell/${MINT}`)
})

test('share card captions put the ref on the market link only', () => {
  const caption = `owner/repo on repo.ing\nGraduation progress: 10%\nSnapshot: 2026-10-01T00:00:00.000Z\nhttps://repo.ing/token/${MINT}`
  assert.equal(captionWithReferral(caption, MINT, wallet), caption.replace(`/token/${MINT}`, `/token/${MINT}?ref=${wallet}`))
  assert.equal(captionWithReferral(caption, MINT, null), caption)
  // The real payout caption (src/market-share.mjs): only its final market line changes, never the receipt link.
  const { caption: payout } = payoutShare({ repoId: '7', fullName: 'owner/repo', mint: MINT },
    { status: 'settled', settledAt: '2026-10-01T00:00:00Z', repoId: '7', claimSignature: 'sig', amountBaseUnits: '1500000000' },
    { status: 'settled', signature: 'sig', amountBaseUnits: '1500000000' })
  const lines = payout.split('\n'), referred = captionWithReferral(payout, MINT, wallet).split('\n')
  assert.equal(lines.at(-1), `https://repo.ing/token/${MINT}`)
  assert.deepEqual(referred, [...lines.slice(0, -1), `https://repo.ing/token/${MINT}?ref=${wallet}`])
})

test('the /referrals link points at the home page, and any page that opens it remembers the referrer', () => {
  assert.equal(siteReferralLink('https://repo.ing', wallet), `https://repo.ing/?ref=${wallet}`)
  const store = new Map(), storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  assert.equal(captureReferral(new URL(siteReferralLink('https://repo.ing', wallet)).search, storage, 1000), wallet)
  assert.equal(storedReferral(storage, Keypair.generate().publicKey.toBase58(), 2000), wallet)
  assert.equal(storedReferral(storage, wallet, 2000), null, 'never the trader\'s own wallet')
})
