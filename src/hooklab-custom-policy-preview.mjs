// Local predicate preview only. This schema is not a recipe, instruction, quote or execution intent.
import { z } from 'zod'
import { hookAddress } from './hooklab-execution-contract.mjs'

export const CUSTOM_POLICY_PREVIEW_PIN = Object.freeze({
  sourceCommit: 'a33957a3f4285351949852ce5fb49cb3616ef496',
  eventSourceCommit: '823442c7a7c3572ddf8ecf82c8084591ebb170c9',
  program: 'BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb',
  idlSha256: 'c8cb0f1e24437eae5f42c36cdd296c5efe3b89817b20651408353481aae0b49f',
  profileSha256: 'e78e58aff9ae0539d34a0492f5db4c58dc643feb1368fa00a34cb62d4ed1a68f',
  policy: 'immutable-canonical-single-blocked-owner',
})

export const customPolicyPreviewSchema = z.object({
  schema: z.literal('repoing/custom-policy-preview/1'),
  blockedOwner: hookAddress.refine(value => value !== '11111111111111111111111111111111'),
  sourceOwner: hookAddress,
  destinationOwner: hookAddress,
}).strict()

export function previewCustomOwnerRule(input) {
  const value = customPolicyPreviewSchema.parse(input)
  const sourceBlocked = value.sourceOwner === value.blockedOwner
  const destinationBlocked = value.destinationOwner === value.blockedOwner
  return { schema: 'repoing/custom-policy-preview-result/1',
    result: sourceBlocked || destinationBlocked ? 'rejected-by-this-rule' : 'not-rejected-by-this-rule',
    sourceBlocked, destinationBlocked, onchainStateChecked: false, transactionSimulated: false,
    economicPostconditions: false, deploymentAdopted: false, executionEnabled: false,
  }
}
