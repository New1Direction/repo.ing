// Draft -> launch handoff: only menu-valid Max wallet drafts continue to the owner-approved launch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { launchableDraft, launchHandoffHref, readLaunchHandoff } from '../app/lib/hooklab-launch-handoff.mjs'

const coin = { name: 'Repo Cat', ticker: 'RCAT' }
test('a Max wallet draft with menu values hands its details to the launch form', () => {
  const { intent } = launchableDraft({ templateId: 'max-wallet', coin, blocks: [{ type: 'max_wallet', pct_bps: 300 }, { type: 'creator_fee', fee_bps: 200 }] })
  assert.deepEqual(intent, { name: 'Repo Cat', symbol: 'RCAT', capBps: 300, creatorFeeBps: 200 })
  const href = launchHandoffHref(intent)
  assert.equal(href, '/hooks/launch-review?name=Repo+Cat&symbol=RCAT&fee=200&cap=300')
  assert.deepEqual(readLaunchHandoff(href.split('?')[1]), { name: 'Repo Cat', symbol: 'RCAT', creatorFeeBps: 200, capBps: 300 })
  assert.equal(launchableDraft({ templateId: 'max-wallet', coin, blocks: [{ type: 'max_wallet', pct_bps: 200 }] }).intent.creatorFeeBps, 100, 'default 1% fee')
})
test('anything this release cannot launch says why in plain words', () => {
  assert.match(launchableDraft({ templateId: 'burns', coin, blocks: [{ type: 'burn' }] }).reason, /Only Max wallet/)
  assert.match(launchableDraft({ templateId: 'max-wallet', coin, blocks: [{ type: 'max_wallet', pct_bps: 200 }, { type: 'burn' }] }).reason, /Remove burn/)
  assert.match(launchableDraft({ templateId: 'max-wallet', coin, blocks: [{ type: 'max_wallet', pct_bps: 250 }] }).reason, /wallet cap of 1%, 2%, 3%, 5%/)
  assert.match(launchableDraft({ templateId: 'max-wallet', coin, blocks: [{ type: 'max_wallet', pct_bps: 200 }, { type: 'creator_fee', fee_bps: 300 }] }).reason, /creator fee of 0.5%, 1%, 2%/)
  assert.match(launchableDraft({ templateId: 'max-wallet', coin: { name: '', ticker: 'X' }, blocks: [{ type: 'max_wallet', pct_bps: 200 }] }).reason, /name/)
})
test('the launch form ignores tampered handoff values', () => {
  assert.deepEqual(readLaunchHandoff('name=' + 'x'.repeat(40) + '&symbol=TOOLONGSYMBOL&fee=9999&cap=7'), {})
})
