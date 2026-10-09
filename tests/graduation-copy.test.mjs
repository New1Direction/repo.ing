import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { stockFeeTerms } from '../src/stock-pair-copy.mjs'

// Not every market graduates at 85 SOL: markets launched before the 85 SOL profile graduate at about 30 SOL (their curve's
// threshold), and each market page shows its own target. The flywheel explainer (home, /how-it-works) and llms.txt say so, and
// llms.txt names the stock-pair exception to "builders claim the fees in SOL" (docs/STOCK_QUOTES.md, "Fee policy").
const decoded = markup => markup.replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&quot;', '"')

test('the flywheel explainer says new markets graduate at 85 SOL and older ones at about 30 SOL', async () => {
  const { FlywheelVideo } = await appModule('app/components/flywheel-video.jsx')
  const text = decoded(html(h(FlywheelVideo, {})))
  assert.ok(text.includes('New markets graduate at 85 SOL, older ones at about 30 SOL (each market page shows its target), and platform revenue buys back $REPOING.'))
  assert.doesNotMatch(text, /At 85 SOL the market graduates/)
  const fee = decoded(html(h(FlywheelVideo, { launchFee: { durationLabel: '10 minutes', startPercent: '50.00%', endPercent: '1.75%' } })))
  assert.ok(fee.includes('buys back $REPOING. New markets also charge a launch fee in their first 10 minutes: it starts at 50.00% and falls to 1.75%.'))
})

test('llms.txt: each market\'s own graduation target, and stock pairs\' fees in the stock with no owner claim', async () => {
  const saved = process.env.DBC_CONFIG
  delete process.env.DBC_CONFIG
  try {
    const { GET } = await import('../app/llms.txt/route.js')
    const text = await (await GET()).text()
    assert.ok(text.includes('graduate to Meteora DAMM v2 once the curve holds its target of real quote reserve: 85 SOL for new markets, about 30 SOL for older ones. ' +
      'Each market page shows its own target.'))
    assert.doesNotMatch(text, /holds 85 SOL/)
    const stock = text.split('\n').find(line => line.startsWith('- Stock pairs are the exception.'))
    assert.ok(stock, 'the stock-pair line')
    assert.ok(stock.includes('(facebook: METAx, microsoft: MSFTx, nvidia: NVDAx)'), 'the mapped organizations, from the registry')
    assert.ok(stock.includes('Its trades pay the same 1.75% fee in the stock: 0.30% to the wallet that launched the market and 1.10% (the builder share and ' +
      "repo.ing's share) to permanent $REPOING / <stock> liquidity, plus 0.35% to the Meteora protocol. A stock pair has no owner claim"))
    assert.ok(stockFeeTerms('METAx').includes('0.30% to the launcher, 1.10% to permanent'), 'the same split the pages state')
    // It follows the builder-fee line it is the exception to.
    const lines = text.split('\n')
    assert.equal(lines.indexOf(stock) - 1, lines.findIndex(line => line.startsWith('- Builder fees accrue even before the maintainers connect.')))
  } finally { if (saved === undefined) delete process.env.DBC_CONFIG; else process.env.DBC_CONFIG = saved }
})
