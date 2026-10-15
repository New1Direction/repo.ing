import { defaultDirectPlan, directPlanSchema } from '../../src/direct-coins.mjs'

const key = 'repoing.direct-coin.v1'

// Keep each lane intact. The original key remains the last-opened draft for old links.
// Unknown/newer recipes throw rather than being reduced to today's narrower schema.
export function loadDirectDraft(storage, lane) {
  const last = storage.getItem(key)
  const previous = last ? directPlanSchema.parse(JSON.parse(last)) : null
  if (previous && !storage.getItem(`${key}.${previous.lane}`)) storage.setItem(`${key}.${previous.lane}`, last)
  if (!lane) return previous ?? defaultDirectPlan()
  const raw = storage.getItem(`${key}.${lane}`)
  if (raw) {
    const plan = directPlanSchema.parse(JSON.parse(raw))
    if (plan.lane !== lane) throw new Error('Saved draft lane mismatch')
    return plan
  }
  return defaultDirectPlan(lane)
}

export function saveDirectDraft(storage, input) {
  const plan = directPlanSchema.parse(input), raw = JSON.stringify(plan)
  storage.setItem(`${key}.${plan.lane}`, raw)
  storage.setItem(key, raw)
}
