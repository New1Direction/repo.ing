import test from 'node:test'
import assert from 'node:assert/strict'
import { fundingYml, launchPostText, launchPostUrl, payoutShareText, payoutShareUrl } from '../app/lib/builder-share.mjs'
import { badgeMarkdown } from '../app/lib/readme-badge.mjs'

const MINT = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const intent = href => { const url = new URL(href); return { host: url.host, path: url.pathname, text: url.searchParams.get('text'), link: url.searchParams.get('url') } }

test('launch kit post names the ticker and repository and links the token page', () => {
  const post = intent(launchPostUrl({ mint: MINT, symbol: 'WIDGET', fullName: 'acme/widget' }))
  assert.deepEqual([post.host, post.path, post.link], ['x.com', '/intent/post', `https://repo.ing/token/${MINT}`])
  assert.equal(post.text, "$WIDGET is live: I just launched a market for acme/widget on repo.ing (@repodoting). Every trade pays the repo's builders in SOL.")
  assert.match(launchPostText({ symbol: 'bad ticker', fullName: 'acme/widget' }), /^I just launched a market for acme\/widget/)
  for (const bad of [{ mint: 'not-a-mint' }, { fullName: 'acme/widget?x=1' }, { fullName: 'https://evil.example/a/b' }, { fullName: '' }]) {
    assert.equal(launchPostUrl({ mint: MINT, symbol: 'WIDGET', fullName: 'acme/widget', ...bad }), null)
  }
})

test('payout share uses the exact claimed lamports, the repository and the token page link', () => {
  const share = intent(payoutShareUrl({ amount: '49700', fullName: 'acme/widget', mint: MINT }))
  assert.equal(share.text, 'I just got paid 0.0000497 SOL for building acme/widget on repo.ing (@repodoting)')
  assert.equal(share.link, `https://repo.ing/token/${MINT}`)
  assert.equal(payoutShareText({ amount: '1234567891234', fullName: 'a/b' }), 'I just got paid 1,234.567891234 SOL for building a/b on repo.ing (@repodoting)')
  assert.equal(payoutShareText({ amount: '1000000000', fullName: 'a/b' }), 'I just got paid 1 SOL for building a/b on repo.ing (@repodoting)')
  for (const amount of ['0', '-5', '1.5', 'abc', '', null, undefined, '012']) assert.equal(payoutShareUrl({ amount, fullName: 'acme/widget', mint: MINT }), null, String(amount))
  assert.equal(payoutShareUrl({ amount: '1', fullName: 'acme/widget', mint: '0OIl' }), null)
  assert.equal(payoutShareUrl({ amount: '1', fullName: 'not a repo', mint: MINT }), null)
})

test("the launch post and payout share carry only a valid sharer's ?ref, like every other share", () => {
  const ref = '4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce'
  assert.equal(intent(launchPostUrl({ mint: MINT, symbol: 'WIDGET', fullName: 'acme/widget', ref })).link, `https://repo.ing/token/${MINT}?ref=${ref}`)
  assert.equal(intent(payoutShareUrl({ amount: '49700', fullName: 'acme/widget', mint: MINT, ref })).link, `https://repo.ing/token/${MINT}?ref=${ref}`)
  for (const bad of [null, '', 'not-a-wallet', `${ref}x`]) {
    assert.equal(intent(launchPostUrl({ mint: MINT, symbol: 'WIDGET', fullName: 'acme/widget', ref: bad })).link, `https://repo.ing/token/${MINT}`)
    assert.equal(intent(payoutShareUrl({ amount: '49700', fullName: 'acme/widget', mint: MINT, ref: bad })).link, `https://repo.ing/token/${MINT}`)
  }
  // The posted text never carries the wallet.
  assert.ok(!intent(payoutShareUrl({ amount: '49700', fullName: 'acme/widget', mint: MINT, ref })).text.includes(ref))
})

test('FUNDING.yml lists the token page as a custom sponsor link; the badge links the same page', () => {
  assert.equal(fundingYml(MINT), `custom: ["https://repo.ing/token/${MINT}"]`)
  for (const bad of ['', 'not-a-mint', `${MINT}"]\nmalicious: x`, null]) assert.throws(() => fundingYml(bad), /Invalid market/)
  assert.match(badgeMarkdown('1388219884', MINT), new RegExp(`\\(https://repo\\.ing/api/badge/1388219884\\)\\]\\(https://repo\\.ing/token/${MINT}\\)$`))
})
