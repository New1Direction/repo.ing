import { z } from 'zod'
import { directPlanSchema } from './direct-coins.mjs'

export const HOOK_LAB_RECIPE_VERSION = 'repo-ing/hook-lab-recipe/1'
export const HOOK_LAB_RECIPE_STORAGE_KEY = 'repo.ing:hook-lab-recipe:1'
export const HOOK_LAB_RECIPE_MAX_BYTES = 65536

// Persistence validates representation, not economics. Unknown blocks/fields remain
// opaque intent; only previewHookLabIntegration(raw, freshInspection) validates them.
const json = z.json()
const rawRecipeShape = z.object({
  format: z.literal('hook-lab/1'),
  coin: z.object({ name: z.string(), ticker: z.string() }).catchall(json),
  blocks: z.array(z.object({ type: z.string() }).catchall(json)),
}).strict()
const envelopeShape = z.object({
  schemaVersion: z.literal(HOOK_LAB_RECIPE_VERSION),
  template: z.enum(['plain', 'creator-rewards', 'burns', 'locks', 'max-wallet', 'half-life']).optional(),
  recipe: rawRecipeShape,
}).strict()

export const hookLabRecipeEnvelopeSchema = z.unknown().transform((value, context) => {
  try { return parseHookLabRecipe(value) } catch (error) {
    context.addIssue({ code: 'custom', message: error.message })
    return z.NEVER
  }
})

// Refuse JS values JSON would silently discard or coerce before Zod can clone them.
// Bound nesting before recursive schema validation, including cyclic input.
function assertJson(value, depth = 0) {
  if (depth > 32) throw new Error('Recipe JSON exceeds 32 levels of nesting.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER && !Object.is(value, -0)) return
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
    throw new Error('Recipe must contain lossless plain JSON values only.')
  }
  const keys = Reflect.ownKeys(value)
  if (Array.isArray(value) && (keys.length !== value.length + 1 || !Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean))) {
    throw new Error('Recipe arrays must be dense and have no extra properties.')
  }
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Recipe properties must be enumerable JSON data.')
    if (/^(secret_?key|private_?key|seed_?phrase|mnemonic|passphrase|privateKeyPkcs8)$/i.test(key)) throw new Error('Signing secrets and recovery credentials do not belong in recipes.')
    assertJson(descriptor.value, depth + 1)
  }
}

function boundedText(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > HOOK_LAB_RECIPE_MAX_BYTES) {
    throw new Error('Recipe JSON must be a string of at most 65536 UTF-8 bytes.')
  }
  return text
}

function parseJson(text) {
  const value = JSON.parse(boundedText(text))
  // JSON.parse silently keeps the last duplicate member, including a conflicting
  // version or fee. Check member names on the already syntax-validated token stream.
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g) ?? []
  const stack = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '{') stack.push(new Set())
    else if (token === '[') stack.push(null)
    else if (token === '}' || token === ']') stack.pop()
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(token), keys = stack.at(-1)
      if (keys.has(key)) throw new Error('Duplicate JSON members cannot be imported losslessly.')
      keys.add(key)
    }
  }
  return value
}

export function parseHookLabRecipe(value) {
  assertJson(value)
  boundedText(JSON.stringify(value))
  // Parse for validation only: never use a schema's normalized projection as storage.
  envelopeShape.parse(value)
  return JSON.parse(JSON.stringify(value))
}

export function createHookLabRecipe(recipe, template) {
  return parseHookLabRecipe({ schemaVersion: HOOK_LAB_RECIPE_VERSION, ...(template === undefined ? {} : { template }), recipe })
}

export function serializeHookLabRecipe(envelope) {
  return JSON.stringify(parseHookLabRecipe(envelope))
}

export function importHookLabRecipe(text) {
  const value = parseJson(text)
  // Raw Hook Lab exports are an explicit supported input, not a legacy-plan migration.
  return value?.format === 'hook-lab/1' ? createHookLabRecipe(value) : parseHookLabRecipe(value)
}

export function resumeHookLabRecipe(envelope) {
  return parseHookLabRecipe(envelope).recipe
}

export function exportHookLabRecipe(envelope) {
  return JSON.stringify(resumeHookLabRecipe(envelope))
}

export function loadHookLabRecipe(storage) {
  const text = storage.getItem(HOOK_LAB_RECIPE_STORAGE_KEY)
  return text === null ? null : parseHookLabRecipe(parseJson(text))
}

export function saveHookLabRecipe(storage, envelope) {
  const text = serializeHookLabRecipe(envelope)
  // A future/incompatible draft must not be destroyed by an older client.
  loadHookLabRecipe(storage)
  storage.setItem(HOOK_LAB_RECIPE_STORAGE_KEY, text)
  return JSON.parse(text)
}

// Deliberately opt-in. Do not call from load/import, mutate the old slot, or apply
// defaults from directPlanSchema: missing, null and explicit zero are different.
export function migrateDirectPlanV1ToHookLabRecipe(input) {
  assertJson(input)
  directPlanSchema.parse(input)
  if (input.lane !== 'programmable' || input.adapter !== 'hooklab' || input.network !== 'devnet' ||
      input.standard !== 'bordrless' || input.quote !== 'bridged-sol' || input.lpPolicy !== 'protocol' ||
      !['none', 'kit', 'halfLife'].includes(input.recipe) ||
      (input.recipe !== 'kit' && input.kitMaxWalletBps != null)) {
    throw new Error('Legacy plan cannot be represented by the Hook Lab recipe contract.')
  }
  const blocks = []
  if (Object.hasOwn(input, 'creatorFeeBps')) blocks.push({ type: 'creator_fee', fee_bps: input.creatorFeeBps })
  if (input.recipe === 'kit') blocks.push({ type: 'max_wallet', ...(Object.hasOwn(input, 'kitMaxWalletBps') ? { pct_bps: input.kitMaxWalletBps } : {}) })
  if (input.recipe === 'halfLife') blocks.push({ type: 'exit_halflife', start_bps: 2000, half_secs: 21600, zero_secs: 172800 })
  return createHookLabRecipe({ format: 'hook-lab/1', coin: { name: input.name, ticker: input.symbol }, blocks })
}

// The authenticated owner is supplied separately by the server, never by JSON.
// Client-generated IDs make an initial save retryable without duplicate drafts.
export const hookLabRecipeSaveSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().min(0).max(2147483646),
  envelope: hookLabRecipeEnvelopeSchema,
}).strict()
