import { createHmac } from 'node:crypto'
import { HANDOFF_AUDIENCE } from './repo-inference-handoff.mjs'

// Every pack pays a builder (docs/CREDITS_WEB.md, "Builder shares"): repo.ing's signed word to the credit ledger that a pack is
// opened for a repository it checked, and that a claimer holds the repository's payout wallet. HMAC-SHA256 (hex) with
// HANDOFF_ASSERTION_SECRET, which only repo.ing and the ledger hold; each text starts with its own version line, so no ticket
// can pass for a handoff assertion. The ledger checks the same texts (repo-inference src/builder_shares.rs) and allows 5 minutes.
export const PACK_BUILDER_TICKET = 'repoing-pack-builder-v1'
export const BUILDER_CLAIM_TICKET = 'repoing-builder-claim-v1'
export const packBuilderMessage = ({ idempotencyKey, githubUserId, repoId, shareBps, issuedAt }) =>
  [PACK_BUILDER_TICKET, HANDOFF_AUDIENCE, idempotencyKey, String(githubUserId), String(repoId), String(shareBps), issuedAt].join('\n')
export const builderClaimMessage = ({ idempotencyKey, githubUserId, repoId, issuedAt }) =>
  [BUILDER_CLAIM_TICKET, HANDOFF_AUDIENCE, idempotencyKey, String(githubUserId), String(repoId), issuedAt].join('\n')
const mac = (secret, message) => createHmac('sha256', secret).update(message).digest('hex')
export const packBuilderTicket = (secret, facts) =>
  ({ repo_id: String(facts.repoId), share_bps: facts.shareBps, issued_at: facts.issuedAt, signature: mac(secret, packBuilderMessage(facts)) })
export const builderClaimTicket = (secret, facts) => ({ issued_at: facts.issuedAt, signature: mac(secret, builderClaimMessage(facts)) })
