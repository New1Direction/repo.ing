// The discoverer table links each market to its token page, except markets marked linked:false (Hugging Face model
// markets while model markets are off), which it names without a link so the page never links to a 404.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

const { DiscovererTable } = await appModule('app/components/growth-surfaces.jsx')
const market = (mint, fullName, extra = {}) => ({ repoId: mint.slice(0, 6), mint, fullName, enrolled: false, ...extra })
const leaders = [{ wallet: 'C4MsJtkJH2QdpTWdsxXJzSJ9JSaK3Xsj4K7BKugsMade', earned: '0', paid: '0', volume: '0', launches: 2, markets: [
  market('EkDLnaWxTBVzJoK6vF8ivNE2EDm54itTjW6pB1vwmF2t', 'google/gemma-4-31B-it', { linked: false }),
  market('2CLx43SKQh5fet6mkxfiod2DEkTK6SeQ7PvYHdter1Pa', 'owner/repo')] }]

test('a hidden model market is named without a link; a repository market keeps its token link', async () => {
  const page = await html(h(DiscovererTable, { leaders }))
  assert.match(page, /google\/gemma-4-31B-it/)
  assert.doesNotMatch(page, /href="\/token\/EkDLnaWx/)
  assert.match(page, /href="\/token\/2CLx43SKQh5fet6mkxfiod2DEkTK6SeQ7PvYHdter1Pa"/)
})
