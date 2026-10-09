import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Stock pairs on the token page and /wallet (follow-up to PR #255): the token page hands ShareMarket the pair, so its share menu
// shows no referral control, Blink link or share card (stock trades carry no referral; Blinks 404 for stock pairs), and /wallet
// values a stock holding in the stock (StockHoldingValue) instead of a SOL price that never comes.
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the token page passes a stock pair to the share menu', () => {
  assert.match(source('app/(site)/token/[mint]/page.jsx'), /<ShareMarket [^>]*\{\.\.\.\(stockPair \? \{ readme: false, quote \} : \{\}\)\}/)
})

test('/wallet shows a stock holding in the stock, and a SOL holding as before', () => {
  const wallet = source('app/components/wallet-overview.jsx')
  assert.match(wallet, /import \{ StockHoldingValue, StockLauncherTile, StockLauncherValue \} from '\.\/stock-launcher-wallet'/)
  assert.match(wallet, /\(m\.stockValue \? <StockHoldingValue value=\{m\.stockValue\}\/> : <span className="wallet-market-value">Value<strong>\{m\.valueLamports === null/)
})
