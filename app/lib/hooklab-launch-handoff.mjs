// Draft -> launch handoff. This release launches exactly one recipe: a max-wallet cap plus an
// optional creator fee, both from the owner's menus, through repo.ing's approval queue. Pure (no
// node: APIs) so client components can use it; the server re-validates everything it receives.
import { CREATOR_FEE_BPS_CHOICES, DEFAULT_CREATOR_FEE_BPS, WALLET_CAP_BPS_CHOICES, percent } from '../../src/hooklab-launch-menus.mjs'

const LAUNCHABLE_BLOCKS = new Set(['max_wallet', 'creator_fee'])
const bytes = value => new TextEncoder().encode(value).length

// { intent } when the draft can launch now, otherwise { reason } in plain words.
export function launchableDraft({ templateId, coin = {}, blocks = [] }) {
  const cap = blocks.find(block => block.type === 'max_wallet'), fee = blocks.find(block => block.type === 'creator_fee')
  if (templateId !== 'max-wallet' || !cap) return { reason: 'Only Max wallet coins can launch right now. Your other rules stay saved as a draft.' }
  const extra = blocks.filter(block => !LAUNCHABLE_BLOCKS.has(block.type)).map(block => block.type.replaceAll('_', ' '))
  if (extra.length) return { reason: `Remove ${extra.join(', ')} to launch now. This release launches a wallet cap and a creator fee only.` }
  const intent = { name: String(coin.name ?? '').trim(), symbol: String(coin.ticker ?? '').trim(), capBps: cap.pct_bps, creatorFeeBps: fee?.fee_bps ?? DEFAULT_CREATOR_FEE_BPS }
  if (!intent.name || bytes(intent.name) > 32 || !intent.symbol || bytes(intent.symbol) > 10) return { reason: 'Give your coin a name (up to 32 bytes) and a ticker (up to 10) first.' }
  if (!WALLET_CAP_BPS_CHOICES.includes(intent.capBps)) return { reason: `Choose a wallet cap of ${WALLET_CAP_BPS_CHOICES.map(percent).join(', ')}.` }
  if (!CREATOR_FEE_BPS_CHOICES.includes(intent.creatorFeeBps)) return { reason: `Choose a creator fee of ${CREATOR_FEE_BPS_CHOICES.map(percent).join(', ')}.` }
  return { intent }
}

export function launchHandoffHref({ name, symbol, creatorFeeBps, capBps }) {
  return `/hooks/launch-review?${new URLSearchParams({ name, symbol, fee: String(creatorFeeBps), cap: String(capBps) })}`
}

// Prefill for the request form; anything invalid is simply ignored.
export function readLaunchHandoff(search) {
  const params = new URLSearchParams(search ?? ''), out = {}
  const name = params.get('name')?.trim(), symbol = params.get('symbol')?.trim(), fee = Number(params.get('fee')), cap = Number(params.get('cap'))
  if (name && bytes(name) <= 32) out.name = name
  if (symbol && bytes(symbol) <= 10) out.symbol = symbol
  if (CREATOR_FEE_BPS_CHOICES.includes(fee)) out.creatorFeeBps = fee
  if (WALLET_CAP_BPS_CHOICES.includes(cap)) out.capBps = cap
  return out
}
