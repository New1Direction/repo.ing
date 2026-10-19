// The creator fee card of a native-SOL coin (coin page and My coins): only the coin's creator sees it, only for a coin
// whose fees are paid in SOL, with "Claim X SOL" while there is something to claim, in plain words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

const creator = 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9', other = '3eCFwDiKetHe9pg1zNEkTohUECu2vtsZDRMZ3jeR4g5o'
const native = (claimableLamports = '5625000') => ({ mint: '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn', native: true, creator, claimableLamports })
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;|’/g, '\'').replace(/\s+/g, ' ').trim()
const jargon = /lamports|basis points|bps|launch account|PDA|rent|native-SOL|quote/i
const view = async props => { const { HookClaimFeesView } = await appModule('app/components/hooklab-claim-fees.jsx'); return html(h(HookClaimFeesView, { symbol: 'NAT', wallet: creator, signedIn: true, onClaim() {}, ...props })) }

test('nothing for a bridged coin, another wallet, no wallet or an unknown coin', async () => {
  for (const props of [{ claim: { ...native(), native: false } }, { claim: native(), wallet: other }, { claim: native(), wallet: null }, { claim: null }, { claim: undefined }])
    assert.equal(await view(props), '', JSON.stringify(props))
})

test('the creator sees what trades paid them and one button: Claim X SOL', async () => {
  const markup = await view({ claim: native() }), page = text(markup)
  assert.match(page, /Your creator fees/); assert.match(page, /Trades of \$NAT have paid you 0\.005625 SOL\. Claiming sends it to this wallet\./)
  assert.match(markup, /<button type="button" class="button primary">Claim 0\.005625 SOL<\/button>/)
  assert.doesNotMatch(page, jargon)
  assert.match(text(await view({ claim: native('937') })), /Claim 0\.000000937 SOL/, 'a few lamports still show')
  assert.match(text(await view({ claim: native('2500000000') })), /Claim 2\.5 SOL/)
})

test('nothing to claim yet: a plain line and no button', async () => {
  const markup = await view({ claim: native('0') })
  assert.match(text(markup), /No fees to claim yet\. Every buy and sell of \$NAT adds to them\./); assert.doesNotMatch(markup, /<button/)
})

test('signed out: the amount and how to claim it, no button', async () => {
  const markup = await view({ claim: native(), signedIn: false })
  assert.match(text(markup), /paid you 0\.005625 SOL.*Sign in with this wallet to claim it\./); assert.doesNotMatch(markup, /<button/)
})

test('while claiming, then done or failed', async () => {
  const busy = await view({ claim: native(), busy: true, step: 'Approve in your wallet' })
  assert.match(busy, /<button type="button" class="button primary" disabled="">Approve in your wallet<\/button>/)
  assert.match(text(await view({ claim: native('0'), done: 'Claimed 0.005625 SOL to your wallet.' })), /Claimed 0\.005625 SOL to your wallet\./)
  const failed = await view({ claim: native(), error: 'The claim failed on Solana. Only its network fee was charged.' })
  assert.match(failed, /role="alert">The claim failed on Solana\. Only its network fee was charged\.</)
})
