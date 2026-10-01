// Repositories repo.ing must never promote: hidden from /waiting (no "Tag them on X"), and to be skipped by
// any feature that features or announces markets. Set as GitHub repository IDs, comma-separated, in
// PROMOTION_EXCLUDED_REPO_IDS (web and worker). Their markets and builder fees are unaffected.
export function promotionExcludedRepoIds(env = process.env) {
  return new Set(String(env.PROMOTION_EXCLUDED_REPO_IDS ?? '')
    .split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id)))
}

export const isPromotionExcluded = (repoId, excluded = promotionExcludedRepoIds()) => excluded.has(String(repoId))
