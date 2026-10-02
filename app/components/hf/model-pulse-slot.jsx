import { Activity } from 'lucide-react'
import { database } from '../../lib/server.mjs'

// Model Pulse on a model's token page: public Hugging Face activity, display only. The data comes from
// app/lib/model-pulse.mjs (phase P1b), which this slot reads when it exists:
//   export async function readModelPulse(pool, marketId)
//   → null, or { items: [{ label, value, detail? }], updatedAt }   (strings; up to six items are shown)
// Until that module ships, or when it has nothing for this model, the slot renders nothing.
async function pulseModule() {
  try { return await import('../../lib/model-pulse.mjs') } catch { return null }
}

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 120
const validItem = item => text(item?.label) && text(item?.value) && (item.detail === undefined || item.detail === null || text(item.detail))

export async function ModelPulseSlot({ market }) {
  const source = await pulseModule()
  if (typeof source?.readModelPulse !== 'function') return null
  let pulse = null
  try { pulse = await source.readModelPulse(database(), market.repoId) }
  catch (error) { console.error('model pulse read failed', { mint: market.mint, error: error.message }) }
  const items = Array.isArray(pulse?.items) ? pulse.items.filter(validItem).slice(0, 6) : []
  if (!items.length) return null
  const updated = pulse.updatedAt && !Number.isNaN(Date.parse(pulse.updatedAt)) ? new Date(pulse.updatedAt) : null
  return <section className="inner-card model-pulse" aria-labelledby="model-pulse-title">
    <h3 id="model-pulse-title"><Activity size={17} aria-hidden="true"/>Model Pulse</h3>
    <dl>{items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}{item.detail && <small>{item.detail}</small>}</dd></div>)}</dl>
    <p className="model-pulse-foot">Public Hugging Face activity, shown for information only: it never pays or rewards anyone.
      {updated && <> Updated <time dateTime={updated.toISOString()}>{updated.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC</time>.</>}</p>
  </section>
}
