import { z } from 'zod'

// Data only: never fetch source URLs, load weights, or execute uploaded code.
export const PERSONALITY_IMPORT_BYTES = 8192
export const PERSONALITY_IMPORT_DRAFT_KEY = 'repoing-neuron-import-v1'
const text = max => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value), 'Unsupported control characters')
const sourceUrl = z.string().max(1000).url().refine(value => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch { return false }
}, 'Use an HTTPS attribution URL without credentials')
export const personalityImportSchema = z.object({
  format: z.literal('repoing-personality'),
  version: z.literal(1),
  name: text(40),
  ticker: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  story: text(280).refine(value => value.length >= 10, 'Story must have at least 10 characters'),
  model: z.object({ id: z.literal('Qwen/Qwen3-8B'), revision: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  steering: z.object({ layer: z.number().int().min(0).max(35), neuron: z.number().int().min(0).max(12287),
    direction: z.enum(['up', 'down']), alpha: z.number().positive().max(10) }).strict(),
  attribution: z.object({ author: text(80), url: sourceUrl }).strict(),
  associatedConcepts: z.object({
    terms: z.array(text(40)).min(1).max(12).refine(terms => new Set(terms.map(term => term.toLowerCase())).size === terms.length, 'Use distinct concepts'),
    method: z.enum(['j-lens', 'r-lens', 'logit-lens', 'creator']),
    sourceUrl,
  }).strict().optional(),
  examples: z.array(z.object({ prompt: text(500), reply: text(500) }).strict()).max(3),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value, null, 2)).length <= PERSONALITY_IMPORT_BYTES, 'Exported personality must fit within 8 KiB')

export function parsePersonalityImport(input) {
  if (new TextEncoder().encode(input).length > PERSONALITY_IMPORT_BYTES) throw Error('Choose a JSON file no larger than 8 KiB.')
  let value
  try { value = JSON.parse(input) } catch { throw Error('This file is not valid JSON.') }
  const result = personalityImportSchema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw Error(`Check ${issue.path.join('.') || 'file format'}: ${issue.message}`)
  }
  return result.data
}

// Downloadable template, not an evaluated persona or a claim that this revision exists.
export const PERSONALITY_IMPORT_TEMPLATE = {
  format: 'repoing-personality', version: 1, name: 'Tidal Thinker', ticker: 'TIDE',
  story: 'A sideways thinker with ocean-sized ideas.',
  model: { id: 'Qwen/Qwen3-8B', revision: 'REPLACE_WITH_EXACT_40_CHARACTER_COMMIT_SHA' },
  steering: { layer: 1, neuron: 4498, direction: 'up', alpha: 1.25 },
  attribution: { author: 'Your name or handle', url: 'https://qwen-neurons-site.vercel.app' },
  associatedConcepts: { terms: ['ocean', 'sideways'], method: 'creator', sourceUrl: 'https://qwen-neurons-site.vercel.app' },
  examples: [{ prompt: 'Tell me about yourself.', reply: 'Replace this with an actual example from your personality.' }],
}
