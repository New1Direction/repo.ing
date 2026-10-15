import { z } from 'zod'

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
export const HOOK_LAB_COMMIT = 'ee7234cb7a32781fecba5470f24f43233cf94167'
export const HOOK_LAB_INTEGRATION_COMMIT = '9b3473e001a9abc73bf644d4206e47abc95a815b'
export const HOOK_LAB_MANIFEST_SHA256 = '3e904e1030f581d8b79879aaf43a5f3c9d20f63979008c2e4b0799581e14e403'
export const HOOK_AUTHORITY = 'HUZSwDaS7u7bfqrrhDUjCVoi6xCVDDXZhM6snvJ3YQdG'
const spl = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const sol = 'So11111111111111111111111111111111111111112'
const hookPrograms = {
  token: '554tgVzsJ6NvQFpKc39HV73EDdarx3PMyDJTohcvHMLJ',
  dex: '3yJKNHzDC7JA979RJNqxKSyo1jt6kLcJNk9bjUuebLN2',
  bridge: 'GXeSHtaGgb68LPsDzrYRfmup3afPsZUHefG2usnu7sgs',
  launch: '4CxedXkUfo6JLXSnzuxr2XA9xeXPsxQeR1xeTedhKMyd',
  kit: 'AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm',
  halfLife: '3TCbABpXPA7ifs2Fge5j1XCbXNSHMdLHEXNMxuMAC6Ub',
}
export const DIRECT_VENUES = {
  raydium: {
    label: 'Raydium LaunchLab', lane: 'standard', standard: 'spl', quote: 'wrapped-sol', quoteMint: sol,
    sdk: '@raydium-io/raydium-sdk-v2 0.2.74-alpha',
    programs: { launch: 'DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6', token: spl },
    curve: 'Config-controlled bonding curve → Raydium CPMM. Supply and graduation target need approved GlobalConfig limits.',
    lp: 'PlatformConfig controls the burn/lock split. Current locked shares belong to the platform Fee Key, not automatically the creator. No per-launch LP override.',
    fees: 'Protocol, platform, creator, migration, rent and network fees are unresolved until configs are approved and read. Unknown does not mean free.',
    authority: 'Fixed supply at initialization. Review metadata authority and platform fee recipients; program upgrades remain possible.',
  },
  'meteora-dbc': {
    label: 'Meteora DBC → DAMM v2', lane: 'standard', standard: 'spl', quote: 'wrapped-sol', quoteMint: sol,
    sdk: '@meteora-ag/dynamic-bonding-curve-sdk 1.5.13',
    programs: { launch: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', dex: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', token: spl },
    curve: 'Approved DBC configuration controls curve, supply and graduation into DAMM v2. No custom curve is approved here.',
    lp: 'Creator/partner positions, permanent locks and vesting come from the config. Position NFTs are not a generic LP burn switch.',
    fees: 'Trading, dynamic, creator/partner, migration, pool creation, rent and network fees require an approved config. No numerical quote yet.',
    authority: 'Standard launch mint authority is revoked; metadata authority and fee/leftover receivers depend on the config.',
  },
  'meteora-damm': {
    label: 'Meteora DAMM v2 liquidity', lane: 'standard', standard: 'spl', quote: 'wrapped-sol', quoteMint: sol,
    sdk: '@meteora-ag/cp-amm-sdk 1.4.10',
    programs: { dex: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', token: spl },
    curve: 'Direct liquidity, not a launch curve. Requires an existing supported base mint, actual deposits, initial price and fee config; these are not set by this draft.',
    lp: 'Position owner controls available liquidity and fees unless a supported lock is applied. No lock or burn has been arranged.',
    fees: 'Deposit amounts, trading/dynamic fees, position rent and network fee are unresolved. No pool or mint will be created.',
    authority: 'Existing mint/freeze/metadata authorities must be inspected independently. A token badge does not guarantee active hook execution.',
  },
  hooklab: {
    label: 'Hook Lab DEX', lane: 'programmable', standard: 'bordrless', quote: 'bridged-sol',
    quoteMint: '9815kDrx6sNiXCnD2CvB8LKNJjbdKWmQYXzH5gYKABSq',
    sdk: 'Hook Lab integration v1 — pinned Node-only inspection and intent preview', programs: hookPrograms,
    curve: 'Native constant-product launch curve with virtual offsets → the same Hook Lab DEX. Virtual quote is not deposited SOL. A devnet check decodes live supply, decimals and bounds; it does not approve them.',
    lp: 'Launch PDA holds LP permanently under the current program. This is a program-enforced lock, not an LP burn, and remains subject to upgrade risk.',
    fees: 'Creator fee applies to buys and sells; hook cuts, burns and protocol fees can stack. Setup documents an 80% sniper fee for 30 seconds (first creator self-buy exception). Read live config economics below; total debit, rent and net output remain unknown.',
    authority: 'Bridge programs custody underlying SOL. Native holdings are not SPL wallet balances. A single manifest key controls upgrades/admin/treasury. No production approval or independent audit.',
  },
}

export const directPlanSchema = z.object({
  version: z.literal(1), lane: z.enum(['standard', 'programmable']),
  adapter: z.enum(['raydium', 'meteora-dbc', 'meteora-damm', 'hooklab']),
  network: z.enum(['devnet', 'mainnet-beta']),
  name: z.string().trim().max(32).regex(/^[\p{L}\p{N} ._-]*$/u),
  symbol: z.string().trim().max(10).regex(/^[A-Z0-9]*$/),
  standard: z.enum(['spl', 'token-2022', 'bordrless']),
  quote: z.enum(['wrapped-sol', 'bridged-sol', 'usdc']),
  recipe: z.enum(['none', 'kit', 'halfLife', 'lottery', 'custom']),
  lpPolicy: z.enum(['protocol', 'burn', 'lock', 'creator']),
  creatorFeeBps: z.number().int().min(0).max(10000).nullable().default(null),
  kitMaxWalletBps: z.number().int().min(1).max(10000).nullable().default(null),
}).strict()

export function defaultDirectPlan(lane = 'standard') {
  return { version: 1, lane, adapter: lane === 'programmable' ? 'hooklab' : 'raydium', network: 'devnet', name: '', symbol: '',
    standard: lane === 'programmable' ? 'bordrless' : 'spl', quote: lane === 'programmable' ? 'bridged-sol' : 'wrapped-sol', recipe: 'none', lpPolicy: 'protocol',
    creatorFeeBps: null, kitMaxWalletBps: null }
}

export function previewDirectCoin(input) {
  const plan = directPlanSchema.parse(input), venue = DIRECT_VENUES[plan.adapter], refusals = []
  if (plan.network !== 'devnet') refusals.push('Mainnet is not enabled. Select devnet; production requires separate approval.')
  if (plan.lane !== venue.lane) refusals.push('This venue cannot serve the selected lane. Hook Lab native coins cannot launch on Raydium or Meteora.')
  if (plan.standard !== venue.standard) refusals.push('This adapter only previews its declared token standard. Token-2022 needs a separately reviewed extension path; native Hook Lab tokens are not SPL.')
  if (plan.quote !== venue.quote) refusals.push('Quote asset is not approved for this adapter. No implicit bridge or asset conversion is allowed.')
  if (plan.lpPolicy !== 'protocol') refusals.push('LP burn, lock and ownership cannot override protocol/config terms in this preview.')
  if (plan.recipe !== 'none' && (plan.adapter !== 'hooklab' || !['kit', 'halfLife'].includes(plan.recipe))) refusals.push('This hook recipe is not supported by this adapter. Lottery and arbitrary hooks are disabled.')
  const blockers = ['Transaction generation, signing and sending are disabled; owner approval is required.',
    plan.adapter === 'hooklab' ? 'Exact debit/rent/fee accounting, client mint-key retention, non-atomic recovery, hook-aware trading quotes and signed beta acceptance are outstanding.'
      : 'Approved configuration identities, live economics and transaction simulation are outstanding.']
  if (!plan.name || !plan.symbol) blockers.push('Enter a coin name and symbol before final review.')
  if (plan.adapter === 'hooklab' && (plan.creatorFeeBps === null || (plan.recipe === 'kit' && plan.kitMaxWalletBps === null))) blockers.push('Enter explicit creator fee and Kit max-wallet parameters for a native intent preview. Identity inspection is still available.')
  const recipe = plan.recipe === 'halfLife' ? 'Half-Life has a fixed 20% initial exit fee, halving every 6 hours, zero after 48 hours. Prepare → launch → furnace-light is non-atomic.'
    : plan.recipe === 'kit' ? 'This integration previews Kit max-wallet only; rewards and locks are not configured by this form. Parameters require live config validation. Kit cannot combine with Half-Life.'
      : 'No optional token hook requested. Protocol pool rules and fees still apply.'
  return { plan, venue, compatible: refusals.length === 0, refusals, blockers, recipe,
    mode: 'plan-preview', canBuild: false, canSign: false, canSubmit: false,
    quote: null, simulation: { status: 'not-run', reason: 'No transaction is generated. This is a plan preview, not an RPC simulation.' } }
}
