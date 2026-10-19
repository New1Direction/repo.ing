// Owner moderation of Hooks coins launched through the site. A delisted coin leaves discovery, its page shows the reason,
// and the site stops offering BUY for it. SELL and the creator's fee CLAIM always keep working, so a delisting never
// traps a holder. Pure policy text and checks; the store keeps the append-only record (hook_lab_coin_moderation).

// ---------------------------------------------------------------------------------------------------------------------
// PLACEHOLDER: the owner's content rules are pending. Replace these entries with the owner's delisting reasons (code ->
// the sentence shown on the coin page). Nothing below depends on the wording.
export const DELISTING_REASONS = Object.freeze({
  'placeholder-content-rules': 'PLACEHOLDER: removed under repo.ing\'s content rules (owner text pending).',
})
// ---------------------------------------------------------------------------------------------------------------------

export const isDelistingReason = code => typeof code === 'string' && Object.hasOwn(DELISTING_REASONS, code)
// What the coin page shows for a delisted coin, and what a refused BUY says.
export const delistedNotice = code => `repo.ing has delisted this coin: ${DELISTING_REASONS[code] ?? 'see repo.ing\'s content rules'} You can still sell it, and its creator can still claim fees.`
export const DELISTED_BUY_REFUSAL = 'repo.ing has delisted this coin, so the site no longer offers buying it. You can still sell.'
// The coin's current state from its moderation records (oldest first): the latest action wins.
export function moderationState(records) {
  const latest = [...(records ?? [])].sort((a, b) => Number(a.id) - Number(b.id)).at(-1)
  return latest?.action === 'delist' ? Object.freeze({ delisted: true, reason: latest.reason, notice: delistedNotice(latest.reason), at: new Date(latest.decided_at).toISOString() })
    : Object.freeze({ delisted: false })
}
