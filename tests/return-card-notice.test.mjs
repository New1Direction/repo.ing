import test from 'node:test'
import assert from 'node:assert/strict'
import { HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

// A shared return's image (app/(site)/token/[mint]/return/[pct]/image) carries its own caveat: anyone can edit the figure in the
// URL, and X shows the image without the page that says so. The caveat sits beside the figure, on the right, never in the
// bottom-left corner X covers with its title.
const { ReturnCard, REPORTED } = await appModule('app/lib/og-return-card.jsx')
const REPOING = { repoId: '1388219884', mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', symbol: 'REPOING', fullName: 'New1Direction/repo.ing' }
const MODEL = { repoId: '4503599627370497', mint: 'MintModelGpt2', symbol: 'GPT2', fullName: 'openai-community/gpt2' }

test('the return image says the figure is reported by the sharer and not verified by repo.ing', () => {
  assert.deepEqual(REPORTED, ['Reported by the sharer.', 'Not verified by repo.ing.'])
  for (const [market, pct, figure] of [[REPOING, 100000, '+100,000.0%'], [REPOING, -99.9, '-99.9%'], [MODEL, 12.5, '+12.5%']]) {
    const card = html(h(ReturnCard, { market, logo: null, pct }))
    const at = card.indexOf(figure), reported = card.indexOf(REPORTED[0]), unverified = card.indexOf(REPORTED[1])
    assert.ok(at > 0 && reported > at && unverified > reported, `${figure}: the caveat follows the figure, in its row`)
    // Before the footer, which is the line X's title chip covers.
    const footer = card.indexOf(market === MODEL ? HF_DISCLAIMER_SHORT : 'Every trade pays the repo’s builders in SOL.')
    assert.ok(footer > unverified, `${figure}: the caveat is not in the footer`)
  }
})

test('the longest figure shrinks so the caveat keeps its room beside it', () => {
  assert.match(html(h(ReturnCard, { market: REPOING, logo: null, pct: 100000 })), /font-size:116px[^>]*>\+100,000\.0%/)
  assert.match(html(h(ReturnCard, { market: REPOING, logo: null, pct: 99999.9 })), /font-size:124px[^>]*>\+99,999\.9%/)
  assert.match(html(h(ReturnCard, { market: REPOING, logo: null, pct: 12.5 })), /font-size:150px[^>]*>\+12\.5%/)
})
