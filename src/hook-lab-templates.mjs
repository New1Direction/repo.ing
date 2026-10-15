import { z } from 'zod'

// Draft authoring only. The pinned server SDK, not this module, decides recipe validity.
export const HOOK_LAB_TEMPLATE_PIN = Object.freeze({
  repository: 'https://github.com/New1Direction/hook-lab',
  deliveryCommit: '9b3473e001a9abc73bf644d4206e47abc95a815b',
  manifestPath: 'sdk/packages/sdk/integration/devnet.json',
  manifestSha256: '3e904e1030f581d8b79879aaf43a5f3c9d20f63979008c2e4b0799581e14e403',
  sourceCommit: 'ee7234cb7a32781fecba5470f24f43233cf94167',
})

export const HOOK_LAB_TEMPLATE_COPY = Object.freeze({
  badge: 'Devnet draft · not a launch',
  action: 'Export recipe draft',
  disclosure: 'Export checks field completeness and format only. The pinned server SDK must validate the recipe against a matching devnet inspection. No transaction, signature, spending, or launch readiness is provided.',
  adoption: 'Templates author complete lossless recipes. Drafting, saving and inspection are supported; no template implies executable launch support.',
  fees: 'Plain does not mean fee-free. Protocol fees and the protocol-wide sniper fee still apply; inspect current values. Template rates are not an all-in cost or a quote.',
  units: 'Enter whole basis points (100 bps = 1%) and whole seconds. Blank is not zero. No editable rate or duration is preselected.',
})

// `source` points into a raw pinned IDL, except fixed Half-Life constants, which
// live in program code and the recipe parser, not configurable IDL arguments.
export const HOOK_LAB_BLOCKS = {
  creator_fee: {
    title: 'Creator fee', hook: 'none',
    fields: {
      fee_bps: { label: 'Creator fee · buys and sells', unit: 'bps', source: 'bordrless_launch.LaunchConfig.creator_fee_bps',
        help: 'One quote-denominated rate on both sides, accrued for the creator. Not holder rewards, a fee split, or guaranteed income.' },
    },
  },
  holder_rewards: {
    title: 'Holder rewards', hook: 'kit',
    fields: {
      buy_bps: { label: 'Holder rewards · buys', unit: 'bps', source: 'bordrless_launch.LaunchRules.holder_fee_buy_bps',
        help: 'Taken from quote input for the holder vault. Rewards use bridged SOL; eligibility rules apply. Not a creator payout.' },
      sell_bps: { label: 'Holder rewards · sells', unit: 'bps', source: 'bordrless_launch.LaunchRules.holder_fee_sell_bps',
        help: 'Taken from quote output after the protocol fee for the holder vault. A positive rate on either side activates Kit rewards.' },
    },
  },
  burn: {
    title: 'Trade burns', hook: 'none',
    fields: {
      buy_bps: { label: 'Burn · buys', unit: 'bps', source: 'bordrless_launch.LaunchRules.burn_buy_bps',
        help: 'Burn this token from buy output. Not a buyback or a burn of another coin.' },
      sell_bps: { label: 'Burn · sells', unit: 'bps', source: 'bordrless_launch.LaunchRules.burn_sell_bps',
        help: 'Burn this token from sell input. Burning does not guarantee price appreciation.' },
    },
  },
  creator_lock: {
    title: 'Creator lock', hook: 'kit',
    fields: {
      days_secs: { label: 'Creator unlock · seconds from launch', unit: 'seconds', source: 'bordrless_launch.LaunchRules.creator_lock_secs',
        help: 'Despite the wire name days_secs, enter seconds. Locks the creator wallet, not LP liquidity or a vesting allocation. Explicit zero disables it.' },
    },
  },
  early_lock: {
    title: 'Early-buyer lock', hook: 'kit',
    fields: {
      window_secs: { label: 'Early-buy window · seconds from launch', unit: 'seconds', source: 'bordrless_launch.LaunchRules.early_window_secs',
        help: 'Pool purchases within this launch-relative window are subject to the early-buyer lock.' },
      lock_secs: { label: 'Early-buyer unlock · seconds from launch', unit: 'seconds', source: 'bordrless_launch.LaunchRules.early_lock_secs',
        help: 'An unlock offset from launch, not a duration added to each purchase. Must end after the buy window; the SDK validates this relationship. Remove the block to omit this rule.' },
    },
  },
  max_wallet: {
    title: 'Max wallet', hook: 'kit',
    fields: {
      pct_bps: { label: 'Wallet cap · share of initial supply', unit: 'bps', source: 'bordrless_launch.LaunchRules.max_wallet_bps',
        help: '200 bps means 2% of initial supply, not 200 tokens. Burns do not tighten the fixed token cap. The cap lifts at graduation; it is not a per-person ownership limit.' },
    },
  },
  exit_halflife: {
    title: 'Fixed Half-Life', hook: 'halfLife',
    fields: {
      start_bps: { label: 'Initial exit burn', unit: 'bps', fixed: 2000, source: 'programs/half_life/src/lib.rs#MAX_FEE_PPM',
        help: 'Fixed at 20%. The program uses 200,000 parts per million; the recipe uses 2,000 basis points.' },
      half_secs: { label: 'Half-life interval', unit: 'seconds', fixed: 21600, source: 'programs/half_life/src/lib.rs#HALF_LIFE_SECS',
        help: 'Fixed at 6 hours, with linear interpolation between halvings.' },
      zero_secs: { label: 'Exit burn reaches zero', unit: 'seconds', fixed: 172800, source: 'programs/half_life/src/lib.rs#ZERO_AFTER_HALVINGS',
        help: 'Fixed at 48 hours of token age, not 48 hours after launch. Incoming tokens blend holding age; wallet transfers carry age forward.' },
    },
  },
}

export const HOOK_LAB_TEMPLATES = [
  {
    id: 'plain', title: 'Plain', subtitle: 'Start without a token hook.',
    description: 'No optional rules selected. Add a creator fee or trade burn only if you intend to charge it.',
    requiredBlocks: [], optionalBlocks: ['creator_fee', 'burn'],
    warnings: ['Protocol-wide fees still apply. This is not a fee-free launch.'],
  },
  {
    id: 'creator-rewards', title: 'Creator rewards', subtitle: 'Support the creator through swap fees.',
    description: 'Choose one creator fee for buys and sells. Holder rewards are a separate, optional Kit rule, not another name for creator fees.',
    requiredBlocks: ['creator_fee'], optionalBlocks: ['holder_rewards', 'burn', 'max_wallet', 'creator_lock', 'early_lock'],
    warnings: ['No guaranteed earnings, automatic payout, custom beneficiary, or companion fee splitting is configured.'],
  },
  {
    id: 'burns', title: 'Trade burns', subtitle: 'Burn a chosen share on each side.',
    description: 'Set buy and sell burns independently. These pool rules do not consume the token-hook slot.',
    requiredBlocks: ['burn'], optionalBlocks: ['creator_fee'],
    warnings: ['Burns reduce tokens received or available to sell. They are not buybacks and do not guarantee price appreciation.'],
  },
  {
    id: 'locks', title: 'Wallet locks', subtitle: 'Make transfer restrictions explicit.',
    description: 'Start with a creator-wallet lock; optionally lock early pool purchases. Both clocks start at launch.',
    requiredBlocks: ['creator_lock'], optionalBlocks: ['early_lock', 'creator_fee', 'holder_rewards', 'burn', 'max_wallet'],
    warnings: ['Locks can prevent transfers and sells. These are token-wallet restrictions, not LP locks or vesting. Kit cannot combine with Half-Life.'],
  },
  {
    id: 'max-wallet', title: 'Max wallet', subtitle: 'Cap each wallet against initial supply.',
    description: 'Choose a wallet cap in basis points of initial supply. The token cap stays fixed through burns and lifts at graduation.',
    requiredBlocks: ['max_wallet'], optionalBlocks: ['creator_fee', 'holder_rewards', 'burn', 'creator_lock', 'early_lock'],
    warnings: ['One person may control multiple wallets. This is not an anti-Sybil guarantee. Kit cannot combine with Half-Life.'],
  },
  {
    id: 'half-life', title: 'Fixed Half-Life', subtitle: '20% initially · halves every 6h · zero at 48h.',
    description: 'An age-based exit burn on outgoing wallet transfers and sells, additional to pool rules. Pool buys are exempt from this exit burn.',
    requiredBlocks: ['exit_halflife'], optionalBlocks: ['creator_fee', 'burn'],
    warnings: ['The curve is fixed, not editable. Token age is balance-weighted, not time since launch. Half-Life cannot combine with Kit rewards, wallet caps, or locks.'],
  },
]

const templateIds = HOOK_LAB_TEMPLATES.map(template => template.id)
const integer = unit => z.number().int().min(0).max(unit === 'bps' ? 10000 : 0xffffffff)
const blockSchema = nullable => z.discriminatedUnion('type', Object.entries(HOOK_LAB_BLOCKS).map(([type, block]) =>
  z.object({ type: z.literal(type), ...Object.fromEntries(Object.entries(block.fields).map(([key, field]) => {
    const value = field.fixed === undefined ? integer(field.unit) : z.literal(field.fixed)
    return [key, nullable && field.fixed === undefined ? value.nullable() : value]
  })) }).strict(),
))

export const hookLabTemplateDraftSchema = z.object({
  templateId: z.enum(templateIds),
  coin: z.object({ name: z.string(), ticker: z.string() }).strict(),
  blocks: z.array(blockSchema(true)),
}).strict().superRefine((draft, context) => {
  const template = HOOK_LAB_TEMPLATES.find(candidate => candidate.id === draft.templateId)
  const allowed = [...template.requiredBlocks, ...template.optionalBlocks]
  const seen = new Set()
  draft.blocks.forEach((block, index) => {
    if (!allowed.includes(block.type)) context.addIssue({ code: 'custom', path: ['blocks', index, 'type'], message: `${block.type} is not part of the ${template.title} template.` })
    if (seen.has(block.type)) context.addIssue({ code: 'custom', path: ['blocks', index, 'type'], message: `Keep one ${block.type} block.` })
    seen.add(block.type)
  })
  for (const type of template.requiredBlocks) {
    if (!seen.has(type)) context.addIssue({ code: 'custom', path: ['blocks'], message: `The ${template.title} template requires ${type}.` })
  }
})

const recipeSchema = z.object({
  format: z.literal('hook-lab/1'),
  coin: z.object({
    name: z.string().trim().min(1).refine(value => new TextEncoder().encode(value).length <= 32, 'Use at most 32 UTF-8 bytes for the coin name.'),
    ticker: z.string().regex(/^[A-Za-z0-9]{1,10}$/, 'Use 1–10 ASCII letters or digits for the ticker.').transform(value => value.toUpperCase()),
  }).strict(),
  blocks: z.array(blockSchema(false)),
}).strict()

/** Editable fields are intentionally null. Fixed program constants are not defaults. */
export function createHookLabTemplateDraft(templateId, coin = { name: '', ticker: '' }) {
  const id = z.enum(templateIds).parse(templateId)
  const template = HOOK_LAB_TEMPLATES.find(candidate => candidate.id === id)
  return hookLabTemplateDraftSchema.parse({ templateId: id, coin, blocks: template.requiredBlocks.map(type => ({
    type, ...Object.fromEntries(Object.entries(HOOK_LAB_BLOCKS[type].fields).map(([key, field]) => [key, field.fixed ?? null])),
  })) })
}

/**
 * Returns raw recipe JSON, never an intent or a validity/readiness flag.
 * Throws ZodError (with field paths) for incomplete or malformed input.
 * Then the SERVER must call previewHookLabIntegration(raw, inspection).
 * Live ceilings, fee sums, lock relationships and inspection refusals belong there.
 */
export function exportHookLabTemplate(draft) {
  const { coin, blocks } = hookLabTemplateDraftSchema.parse(draft)
  return recipeSchema.parse({ format: 'hook-lab/1', coin, blocks })
}
