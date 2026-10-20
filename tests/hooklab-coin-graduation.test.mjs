// What a first-time visitor sees about graduation: before (progress and SOL to go), a full curve that is graduating,
// and after (badge, locked liquidity, lifted max wallet), on the coin card and in the whole coin page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/hooklab-graduation-vectors.json', import.meta.url)))
const config = vectors.configs.find(c => c.name === 'Vq 53.25 SOL, fee 100'), at = label => config.states.find(s => s.label === label)
const mint = '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn', g = at('complete').graduation
const base = { mint, name: 'Graduate Coin', symbol: 'GRAD', uri: '', decimals: 6, observedSlot: 1, selectedConfig: '5hvm6s9DCiYX5QQFDVkcTKs1sF3PCKnACxYLHHTJCKZr',
  creator: 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9', capBps: 200, creatorFeeBps: 100, initialSupply: config.supply, capRaw: '20000000000000',
  marketCapLamports: '425999999999', graduationQuote: config.curve.graduationQuote, reserveTokens: config.curve.reserveTokens }
const markets = {
  before: { ...base, graduated: false, curveComplete: false, pool: { ...at('near the end').pool, swapCount: '40' }, curveProgressBps: 9838,
    solToGraduationLamports: at('near the end').finalFill.amountIn, graduation: null },
  graduating: { ...base, graduated: false, curveComplete: true, pool: { ...at('complete').pool, swapCount: '41' }, curveProgressBps: 10000, solToGraduationLamports: null,
    graduation: { at: null, topup: g.topup, burned: g.burned, lockedLp: g.lpLocked, lpSupply: g.lpSupply, baseReserve: g.after.baseReserve, quoteReserve: g.after.quoteReserve } },
  graduated: { ...base, graduated: true, curveComplete: false, pool: { ...g.after, swapCount: '42' }, curveProgressBps: 10000, solToGraduationLamports: null,
    graduation: { at: 1_760_000_000, topup: g.topup, burned: g.burned, lockedLp: g.lpLocked, lpSupply: g.lpSupply } },
}
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;|’/g, '\'').replace(/\s+/g, ' ')
const jargon = /basis points|bps|base units|lamports|LP token|virtual|reserve_|graduation_quote|curve_bps/i

test('before graduation: how far along the curve is, and how much SOL finishes it', async () => {
  const { HookCoinGraduation } = await appModule('app/components/hooklab-coin-graduation.jsx')
  const page = text(html(h(HookCoinGraduation, { market: markets.before })))
  assert.match(page, /Bonding curve 98\.3%/)
  assert.match(page, /1\.738 SOL to graduation/, 'the exact final fill, rounded for reading')
  assert.match(page, /open market/); assert.match(page, /locked forever/); assert.match(page, /no wallet can hold more than 2%/i)
  assert.doesNotMatch(page, /Graduated|Graduating/); assert.doesNotMatch(page, jargon)
  const noFill = text(html(h(HookCoinGraduation, { market: { ...markets.before, solToGraduationLamports: null } })))
  assert.match(noFill, /About 1\.72 SOL to graduation/, 'without an exact fill: what the curve still needs')
})

test('a full curve: "Graduating…" with a plain explanation of what happens next', async () => {
  const { HookCoinGraduation } = await appModule('app/components/hooklab-coin-graduation.jsx')
  const markup = html(h(HookCoinGraduation, { market: markets.graduating })), page = text(markup)
  assert.match(page, /Graduating…/); assert.match(page, /The curve is full/)
  assert.match(page, /106\.5 SOL and 250,000,000 \$GRAD/, 'what moves into the open market')
  assert.match(page, /locked forever/); assert.match(page, /max per wallet lifts/); assert.match(page, /Anyone can/)
  assert.match(markup, /role="status"/); assert.doesNotMatch(page, /to graduation|Graduated/); assert.doesNotMatch(page, jargon)
})

test('after graduation: a Graduated badge, liquidity locked forever, max wallet lifted, and the numbers', async () => {
  const { HookCoinGraduation } = await appModule('app/components/hooklab-coin-graduation.jsx')
  const page = text(html(h(HookCoinGraduation, { market: markets.graduated })))
  for (const expected of [/Graduated/, /Oct 9, 2025/, /Liquidity locked forever/, /no way to withdraw it\. Not even the creator can pull it/, /Max wallet lifted/, /any amount of \$GRAD/, /In the market 106\.5 SOL/,
    /Coins in the market 250,000,000 \$GRAD/, /Creator fee 1% per trade/])
    assert.match(page, expected)
  assert.doesNotMatch(page, /Graduating|to graduation|Bonding curve/); assert.doesNotMatch(page, jargon)
})

test('the coin page carries each state into the Blocks and the trade panel', async () => {
  const { default: Token } = await appModule('app/(site)/hooks/token/[mint]/page.jsx')
  // A fresh mint per render: the page caches each coin's market for a few seconds.
  const key = Symbol.for('repo.ing.hooklab.inclusive-trade-runtime'), render = async market => {
    const fresh = Keypair.generate().publicKey.toBase58()
    // Coin pages show only coins launched through repo.ing (#316), so the runtime lists this one.
    globalThis[key] = { market: async requested => requested === fresh ? { market: { ...market, mint: fresh }, wallet: null } : null,
      coinProfile: async requested => requested === fresh ? { id: '11111111-1111-4111-8111-111111111111', name: market.name, symbol: market.symbol, creator: market.creator, profile: null } : null }
    try { return text(html(await Token({ params: Promise.resolve({ mint: fresh }) }), { wallet: true })) } finally { delete globalThis[key] }
  }
  const before = await render(markets.before)
  assert.match(before, /SOL to graduation/); assert.match(before, /until graduation/); assert.doesNotMatch(before, /Graduated|graduating/)
  const graduating = await render(markets.graduating)
  assert.match(graduating, /Graduating…/); assert.match(graduating, /Buying pauses until it opens on its new market; you can still sell/)
  const graduated = await render(markets.graduated)
  assert.match(graduated, /Graduated/); assert.match(graduated, /Lifted at graduation/); assert.doesNotMatch(graduated, /until graduation|Max 2% per wallet/)
  assert.match(graduated, /No max per wallet · 1% creator fee/); assert.match(before, /Max 2% per wallet · 1% creator fee/)
  assert.match(graduated, /has graduated to its open market\. Trading it on repo\.ing opens again soon/)
  for (const market of Object.values(markets)) {
    const selected = { ...market, policyKind: 'selected-hook', capBps: 0,
      selectedHook: { program: mint, flags: 3 } }
    delete selected.capRaw
    const shown = await render(selected)
    assert.match(shown, /Custom hook · No max-wallet gate/)
    assert.match(shown, /selected hook remains active/i)
    assert.doesNotMatch(shown, /Max 0%|Max wallet lifted|max per wallet lifts|no wallet can hold more|any wallet can hold any amount/i)
  }
})
