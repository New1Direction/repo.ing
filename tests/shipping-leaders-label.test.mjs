import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

const { ShippingLeaders } = await appModule('app/components/shipping-leaders.jsx')
const card = extra => ({ repoId: '1', mint: 'Mint1', fullName: 'New1Direction/korg', symbol: 'KORG', pulse: { commits7d: 4, merged7d: 4, devs7d: 1 }, ...extra })

test('a new repository on the home Shipping tab carries the "New repo" label; others do not', () => {
  assert.match(html(h(ShippingLeaders, { markets: [card({ newRepo: true })] })), /badge new-repo compact/)
  assert.doesNotMatch(html(h(ShippingLeaders, { markets: [card({ newRepo: false })] })), /new-repo/)
})
