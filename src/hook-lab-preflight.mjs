import { createHash } from 'node:crypto'
import { integrationManifest, inspectDevnetIntegration, previewHookLabIntegration } from '@repo-ing/hooklab-readonly'
import { HOOK_LAB_MANIFEST_SHA256 } from './direct-coins.mjs'
import { HOOK_LAB_BLOCKS } from './hook-lab-templates.mjs'
import { parseHookLabRecipe, serializeHookLabRecipe } from './hook-lab-recipe.mjs'
import { QUOTE_PIN } from './hooklab-quote-model.mjs'

// A persisted extension is not a capability. The pinned parser ignores some
// unknown fields; refuse those here instead of approving a normalized subset.
export function hookLabRecipeRefusals(envelope) {
  const { recipe } = parseHookLabRecipe(envelope)
  const refusals = []
  if (recipe.blocks.length) refusals.push({ code: 'PLAIN_ONLY_BETA', subject: 'blocks',
    message: 'This beta accepts plain coins with no rule blocks. Stored rules are preserved, never silently removed or executed.',
  })
  const unknown = (value, allowed, subject) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) refusals.push({
      code: 'UNSUPPORTED_RECIPE_FIELD', subject: `${subject}.${key}`, message: 'Preserved in your draft, but not supported by this consumer. No intent is approved.',
    })
  }
  unknown(recipe.coin, ['name', 'ticker'], 'coin')
  recipe.blocks.forEach((block, index) => {
    const known = Object.hasOwn(HOOK_LAB_BLOCKS, block.type) && HOOK_LAB_BLOCKS[block.type]
    unknown(block, known ? ['type', ...Object.keys(known.fields)] : [], `blocks[${index}]`)
  })
  return refusals
}

export const hookLabLaunchQuote = Object.freeze({
  status: 'unavailable', executable: false, capEnforced: false, exactWalletDebitLamports: null,
  reason: 'The adopted model covers hypothetical swaps only. Launch fees, nested pool fees, rent, bridge funding and an exact message are not a guarded launch quote.',
  modelManifestSha256: QUOTE_PIN.manifestSha256,
})

export async function inspectHookLabRecipe(envelope, connection, confirmedNetwork) {
  envelope = parseHookLabRecipe(envelope)
  if (confirmedNetwork !== 'devnet') throw new Error('Explicit devnet confirmation required')
  const manifest = integrationManifest()
  const inspection = await inspectDevnetIntegration(connection, { confirmedNetwork, manifest })
  const extra = hookLabRecipeRefusals(envelope)
  const intent = previewHookLabIntegration(envelope.recipe, inspection)
  intent.refusals.push(...extra)
  // Never retain a seemingly actionable subset after an unsupported field.
  if (extra.length) intent.steps = []
  const recipeDigest = createHash('sha256').update(serializeHookLabRecipe(envelope)).digest('hex')
  const bindingContext = inspection.refusals.length || intent.refusals.length ? null : {
    genesisHash: manifest.genesisHash, recipeDigest, manifestDigest: HOOK_LAB_MANIFEST_SHA256,
    programs: inspection.programs.filter(p => p.binaryHash).map(p => ({ address: p.programId, sha256: p.binaryHash })),
    configs: Object.values(inspection.accounts).map(a => ({ address: a.address, sha256: a.dataSha256 })),
  }
  return { inspection, intent, bindingContext, checkedAt: new Date().toISOString(), quote: hookLabLaunchQuote,
    canBuild: false, canSimulate: false, canSign: false, canSubmit: false }
}
