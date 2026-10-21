// Candidate inventory is supplied by the build owner, never inferred from mutable
// .so files. This module only reads public ELF/IDL bytes; it never builds contracts.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { selectedFixtureStack } from './selected-fixture.mjs'
import { createHash } from 'node:crypto'
import { selectedHookPolicyReleaseSchema, SELECTED_HOOK_REFERENCE_COMMIT } from '../../../src/hooklab-selected-hook-compatibility.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
/** Local configuration only, NOT measured acceptance or release verification. The
 * sentinel digests deliberately identify that absence, never a passing report. */
export function localEconomicPolicyBundle(bundle) {
  const dossier = JSON.parse(bundle.dossierJson), profile = JSON.parse(bundle.profile.json)
  if (dossier.schema !== 'repoing/local-validator-observation/1' || dossier.topology !== 'single-local-validator-two-proxies'
    || dossier.genesisHash === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' || dossier.genesisHash !== profile.genesisHash
    || bundle.config.selectedHookPin !== undefined || bundle.config.selectedHookRelease !== undefined) throw Error('Economic policy requires an unadorned local bundle')
  const selectedHookRelease = selectedHookPolicyReleaseSchema.parse({
    schema: 'repoing/selected-hook-release/2', approvalReference: bundle.config.approvalReference,
    sourceCommit: profile.sourceCommit, profileSha256: bundle.config.profileSha256, dossierSha256: bundle.config.dossierSha256,
    compatibilityPolicy: { schema: 'repoing/selected-hook-compatibility/2', referenceCommit: SELECTED_HOOK_REFERENCE_COMMIT,
      abi: { family: 'bordrless-token-hook-v1', tokenFlagsMask: 255, registryVersion: 1, registryDiscriminator: '02daf6662c38c0cd', maxRegistryExtras: 32, allowExtraSigners: false },
      authority: { immutable: true, timelock: { program: 'BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ', minDelaySeconds: 259200, requireIdle: true }, trustedUpgradeAuthorities: [] } },
    acceptanceSha256: sha('LOCAL-UNMEASURED-ECONOMIC-CANDIDATE-NOT-ACCEPTANCE'),
    releaseVerificationSha256: sha('LOCAL-UNVERIFIED-ECONOMIC-CANDIDATE-NOT-RELEASE'),
  })
  return { ...bundle, config: { ...bundle.config, selectedHookRelease } }
}

const artifact = z.tuple([z.string().regex(/^target\/creator-selected-v1-candidate\/[a-z0-9_]+\.so$/), z.string().regex(/^[a-f0-9]{64}$/)])
const candidateIdl = z.tuple([z.string().regex(/^target\/creator-selected-v1-candidate\/[a-z0-9_]+\.json$/), z.string().regex(/^[a-f0-9]{64}$/)])
export const economicInventorySchema = z.object({
  schema: z.literal('repoing/local-economic-candidate/1'), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  // V1 upgrades launch/swap, not token. Exercise the retained deployed dependency,
  // even when a same-sized locally rebuilt token happens to pass the lifecycle.
  pins: z.object({ launch: artifact, swap: artifact,
    token: z.tuple([z.literal('.amp/in/elf-deployed-token/bordrless_token.so'), z.literal('5fbbb2ebca32ed3df4c0299da3376141969ac6088700c86390d8b05d0c451dab')]),
    gate: artifact, selected: artifact, alternate: artifact }).strict(),
  idls: z.object({ launch: candidateIdl, swap: candidateIdl, gate: candidateIdl }).strict(),
  hooks: z.tuple([
    z.object({ role: z.literal('selected'), program: z.enum(['8KoeKiwydKzdH65uD4Z6uJgR9uKnj2w22HXRSdCXGhF2', '8WpjE7zTWWhLyzXnenjn3P1iXriTZTfgaiKSmf2kugau']), flags: z.literal(65), name: z.literal('Economic transfer tax') }).strict(),
    z.object({ role: z.literal('alternate'), program: z.literal('4P9UnqR2FgD1XjkcpyWzabQCrhPDTQkZy8631jvTnYqL'), flags: z.literal(3), name: z.literal('Transfer receipt (no economic fee)') }).strict(),
  ]),
}).strict().refine(v => v.hooks[0].program !== v.hooks[1].program, 'Distinct hook programs required')
  .refine(v => v.hooks[0].program !== '8WpjE7zTWWhLyzXnenjn3P1iXriTZTfgaiKSmf2kugau' ||
    (v.pins.selected[0] === 'target/creator-selected-v1-candidate/tax_hook_proposed.so' &&
      v.pins.selected[1] === '35dc99b93c474fdbc8d0961c04bc96f28058533e53beba5e1be7d6f2096dc182' &&
      v.pins.gate[1] === '0f3261b6420f20a3c9feb1d5ead5e8cb432ce972e8716d61dda995fe78c1697b'),
  'Proposed tax identity requires its exact ELF and unchanged deployed gate')

export function economicFixtureStack({ upgradeAuthority, inventoryFile = process.env.HOOKS_E2E_ECONOMIC_INVENTORY } = {}) {
  if (!inventoryFile) throw Error('Economic acceptance BLOCKED: HOOKS_E2E_ECONOMIC_INVENTORY must name the build-owner pinned inventory; receipt/tester ELFs are not V1 evidence')
  const candidate = economicInventorySchema.parse(JSON.parse(readFileSync(path.resolve(inventoryFile), 'utf8')))
  return selectedFixtureStack({ upgradeAuthority, candidate })
}
