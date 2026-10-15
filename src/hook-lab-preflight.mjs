import { createHash } from 'node:crypto'
import { freshCandidateManifest } from '@repo-ing/hooklab-guarded-candidate'
import { inspectFreshPlain } from './hooklab-fresh-plain.mjs'
import deployment from './hooklab-fresh-deployment.json' with { type: 'json' }
import { HOOK_LAB_MANIFEST_SHA256 } from './direct-coins.mjs'
import { HOOK_LAB_BLOCKS } from './hook-lab-templates.mjs'
import { parseHookLabRecipe, serializeHookLabRecipe } from './hook-lab-recipe.mjs'

// A persisted extension is not a capability. The pinned parser ignores some
// unknown fields; refuse those here instead of approving a normalized subset.
export function hookLabRecipeRefusals(envelope) {
  const { recipe } = parseHookLabRecipe(envelope)
  const refusals = []
  for (const [field, max] of [['name', 32], ['ticker', 10]]) {
    const bytes = Buffer.byteLength(recipe.coin[field], 'utf8')
    if (bytes < 1 || bytes > max) refusals.push({ code: 'INVALID_COIN_TEXT', subject: `coin.${field}`,
      message: `${field} must contain 1–${max} UTF-8 bytes. The draft is preserved.` })
  }
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
  reason: 'The finalized HLTEST receipt is historical acceptance, not a quote for this draft. Public transaction construction, simulation and signing remain disabled.',
  manifestSha256: HOOK_LAB_MANIFEST_SHA256,
})

export async function inspectHookLabRecipe(envelope, connection, confirmedNetwork) {
  envelope = parseHookLabRecipe(envelope)
  if (confirmedNetwork !== 'devnet') throw new Error('Explicit devnet confirmation required')
  const manifest = freshCandidateManifest()
  const inspection = await inspectFreshPlain(connection, { confirmedNetwork, deployment, observationOnly: true })
  const extra = hookLabRecipeRefusals(envelope)
  const intent = { recipe: 'plain', refusals: [...extra], steps: [], warnings: [
    'Read-only fresh guarded devnet observation, not a launch quote or execution approval.',
    'Native custom tokens are not SPL or Token-2022. Programs remain upgradeable; admin powers remain broad.',
  ], exactWalletDebitLamports: null, rentLamports: null, networkFeeLamports: null, minOutputRaw: null, expiry: null }
  if (!inspection.readyForObservation) intent.refusals.push({ code: 'INSPECTION_INCOMPATIBLE', message: 'Fresh pinned deployment/config verification failed.' })
  const recipeDigest = createHash('sha256').update(serializeHookLabRecipe(envelope)).digest('hex')
  const bindingContext = inspection.refusals.length || intent.refusals.length ? null : {
    genesisHash: manifest.genesisHash, recipeDigest, manifestDigest: HOOK_LAB_MANIFEST_SHA256,
    programs: inspection.programs.map(p => ({ address: p.address, sha256: p.normalizedHash })),
    configs: Object.values(inspection.configs).map(a => ({ address: a.address, sha256: a.dataSha256 })),
  }
  return { inspection, intent, bindingContext, checkedAt: new Date().toISOString(), quote: hookLabLaunchQuote,
    canBuild: false, canSimulate: false, canSign: false, canSubmit: false }
}
