// Owner decision file. Every decision carries an explicit approval marker; execute refuses
// any stage whose decisions are not approved. Plan may preview unapproved values.
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { PublicKey } from '@solana/web3.js'
import { MAINNET_ROLES, ROLE_NAMES } from './pins.mjs'

const key = z.string().refine(v => { try { return new PublicKey(v).toBase58() === v } catch { return false } }, 'base58 public key')
const raw = z.string().refine(v => /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= 0xffffffffffffffffn, 'u64 decimal string')
const bps = z.number().int().min(0).max(10000)
const menu = max => z.array(z.number().int().min(1).max(max)).min(1).max(4).refine(values => values.every((v, i) => i === 0 || v > values[i - 1]), 'menu values must be strictly ascending')
const decision = value => z.object({ value, approved: z.boolean(), note: z.string().optional(), allowed: z.array(z.any()).optional() }).strict()
export const configSchema = z.object({
  schema: z.literal('repoing/hooklab-owner-config/1'),
  network: z.enum(['mainnet-beta', 'local-test']),
  note: z.string().optional(),
  roles: z.object(Object.fromEntries(ROLE_NAMES.map(r => [r, key.optional()]))).strict().optional(),
  decisions: z.object({
    creatorFeeBps: decision(bps), maxCreatorFeeBps: decision(bps), maxRulesFeeBps: decision(bps), launchProtocolShareBps: decision(bps), protocolFeeBps: decision(bps),
    // Owner-approved wallet-cap menu: 1%, 2% (default), 3% or 5%.
    capBps: decision(z.union([z.literal(100), z.literal(200), z.literal(300), z.literal(500)]).nullable()),
    grant: decision(z.object({ creator: key, maxLaunches: raw, expirySlots: raw }).strict()),
    // Per-invite customer grants: one more launch, short expiry. The creator comes from --creator.
    customerGrantPolicy: decision(z.object({ expirySlots: raw.refine(v => BigInt(v) >= 1500n && BigInt(v) <= 216000n, 'expiry between ~10 minutes and ~1 day of slots') }).strict()),
    selectedConfig: decision(key.nullable()),
    canaryMint: decision(key),
    canaryLaunch: decision(z.object({ name: z.string().min(1).max(32), symbol: z.string().min(1).max(10), uri: z.string().max(200), label: z.string().min(1).max(32),
      virtualQuote: raw, maxRentLamports: raw }).strict()),
    canaryBuy: decision(z.object({ amountInRaw: raw, slippageBps: bps, maxPriceImpactBps: z.number().int().min(0).max(1000) }).strict()),
    canarySell: decision(z.object({ amountInRaw: z.union([raw, z.literal('all')]), slippageBps: bps, maxPriceImpactBps: z.number().int().min(0).max(1000) }).strict()),
    fund: decision(z.object({ creatorLamports: raw, adminLamports: raw, treasuryLamports: raw }).strict()),
    canaryWrapLamports: decision(raw),
    collectRoute: decision(z.enum(['sol', 'quote'])),
    lookupTable: decision(key.nullable()),
    // Bounded priority price: at 1.4M CU this caps the priority fee at 0.07 SOL.
    computeUnitPriceMicroLamports: decision(raw.refine(v => BigInt(v) <= 50000n, 'compute unit price above 50,000 micro-lamports')),
    // Self-serve launches (open-creation stage): the creator-fee and max-per-wallet menus the chain offers, 1 to 4 strictly
    // ascending bps values each. Never defaulted: the stage refuses without an approved value here.
    openCreationMenus: decision(z.object({ creatorFeeBps: menu(9999), capBps: menu(9999) }).strict().nullable()).optional(),
    // The creation fee every launch pays the treasury (launch-fee stage), in lamports. Owner-confirmed 20,000,000 (0.02 SOL):
    // the default when this decision is absent (DECISION_DEFAULTS).
    launchFeeLamports: decision(raw.nullable()).optional(),
    // Our own stack's governance custody digest (launch- and swap-governance-init): the 32-byte custody manifest digest the
    // governance records, as 64 hex. Never defaulted.
    stackCustodyDigest: decision(z.string().regex(/^[a-f0-9]{64}$/, '64 lowercase hex').nullable()).optional(),
  }).strict(),
}).strict()

// Stage -> decisions that must be approved before execute. Plan reports the same list.
export const STAGE_DECISIONS = Object.freeze({
  'launch-config': ['maxCreatorFeeBps', 'maxRulesFeeBps', 'computeUnitPriceMicroLamports'],
  'swap-config': ['launchProtocolShareBps', 'protocolFeeBps', 'computeUnitPriceMicroLamports'],
  grant: ['grant', 'computeUnitPriceMicroLamports'],
  'customer-grant': ['customerGrantPolicy', 'computeUnitPriceMicroLamports'],
  'gate-finalize': ['computeUnitPriceMicroLamports'],
  fund: ['fund', 'computeUnitPriceMicroLamports'],
  alt: ['selectedConfig', 'canaryMint', 'capBps', 'creatorFeeBps', 'canaryLaunch', 'lookupTable', 'computeUnitPriceMicroLamports'],
  'canary-prepare': ['selectedConfig', 'canaryMint', 'capBps', 'creatorFeeBps', 'canaryLaunch', 'computeUnitPriceMicroLamports'],
  'canary-gates-open-creation': ['computeUnitPriceMicroLamports'],
  'canary-gates-close-creation': ['computeUnitPriceMicroLamports'],
  'canary-launch': ['selectedConfig', 'canaryMint', 'capBps', 'creatorFeeBps', 'canaryLaunch', 'lookupTable', 'computeUnitPriceMicroLamports'],
  'canary-holdings': ['canaryMint', 'canaryWrapLamports', 'canaryBuy', 'computeUnitPriceMicroLamports'],
  'canary-buy': ['selectedConfig', 'canaryMint', 'capBps', 'creatorFeeBps', 'canaryBuy', 'lookupTable', 'computeUnitPriceMicroLamports'],
  'canary-sell': ['selectedConfig', 'canaryMint', 'capBps', 'creatorFeeBps', 'canarySell', 'lookupTable', 'computeUnitPriceMicroLamports'],
  collect: ['canaryMint', 'collectRoute', 'computeUnitPriceMicroLamports'],
  'trade-table': ['computeUnitPriceMicroLamports'],
  'open-launches': ['computeUnitPriceMicroLamports'], 'close-launches': ['computeUnitPriceMicroLamports'],
  'open-trading': ['computeUnitPriceMicroLamports'], 'close-trading': ['computeUnitPriceMicroLamports'],
  // The bounds themselves are the owner decision of 2026-10-19, pinned in src/hooklab-launch-pricing.mjs.
  'launch-usd-bounds': ['computeUnitPriceMicroLamports'],
  // On or off comes from --to; the switch itself is the owner decision recorded in the reviewed plan.
  'native-launches': ['computeUnitPriceMicroLamports'],
  // Self-serve launches: the menus come from the config file (never defaulted), on or off from --to.
  'open-creation': ['openCreationMenus', 'computeUnitPriceMicroLamports'],
  'launch-fee': ['launchFeeLamports', 'computeUnitPriceMicroLamports'],
  'launch-table': ['computeUnitPriceMicroLamports'],
  // The guardian's emergency pause; which gates comes from --pause creation|trading|both.
  'guardian-pause': ['computeUnitPriceMicroLamports'],
  // Our own stack's first-time setup (--stack). Read-only checks have no decisions.
  'stack-verify': [], 'quote-marker': [],
  'launch-config-init': ['computeUnitPriceMicroLamports'], 'swap-config-init': ['computeUnitPriceMicroLamports'],
  'launch-governance-init': ['stackCustodyDigest', 'computeUnitPriceMicroLamports'], 'swap-governance-init': ['stackCustodyDigest', 'computeUnitPriceMicroLamports'],
  'collect-native': ['computeUnitPriceMicroLamports'],
  status: [],
})
// Irreversible, fund-moving, gate-opening or launch-economics stages need a per-run --approved STAGE:<message sha256>.
export const APPROVAL_FLAG_STAGES = Object.freeze(new Set(['gate-finalize', 'fund', 'canary-gates-open-creation', 'canary-buy', 'canary-sell', 'trade-table', 'open-launches', 'open-trading',
  'launch-usd-bounds', 'native-launches', 'open-creation', 'launch-fee', 'launch-table', 'launch-config-init', 'swap-config-init', 'launch-governance-init',
  'swap-governance-init', 'collect-native']))
// Decisions with an owner-confirmed default, used when the config file does not carry them.
export const DECISION_DEFAULTS = Object.freeze({
  launchFeeLamports: Object.freeze({ value: '20000000', approved: true, note: 'owner-confirmed 2026-10-19: the 0.02 SOL creation fee' }),
})
export const decisionOf = (config, name) => config.decisions[name] ?? DECISION_DEFAULTS[name] ?? null
// A decision's value, or null when the file does not carry it (an optional decision); defaults are not applied here.
export const decisionValue = (config, name) => config.decisions[name]?.value ?? null

export function loadConfig(path) {
  const parsed = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  if (parsed.network === 'mainnet-beta') {
    if (parsed.roles && Object.entries(parsed.roles).some(([role, address]) => role !== 'selectedConfig' && address !== undefined && MAINNET_ROLES[role] !== address))
      throw Error('Mainnet config may not substitute pinned role addresses')
    if (parsed.decisions.canaryMint.value !== MAINNET_ROLES.mint) throw Error('Mainnet canary mint is pinned to the controlled-test mint')
    if (parsed.decisions.grant.value.creator !== MAINNET_ROLES.creator) throw Error('Mainnet grant creator is pinned to the controlled-test creator')
  }
  return parsed
}
export function value(config, name) { return config.decisions[name].value }
export function unapproved(config, stage) {
  return (STAGE_DECISIONS[stage] ?? []).filter(name => !decisionOf(config, name)?.approved)
}
// lookupTable may stay null: the alt stage records the table it created.
const NULLABLE = new Set(['lookupTable'])
export function missing(config, stage) {
  return (STAGE_DECISIONS[stage] ?? []).filter(name => (decisionOf(config, name)?.value ?? null) === null && !NULLABLE.has(name))
}
export function assertExecutable(config, stage) {
  const pending = unapproved(config, stage), absent = missing(config, stage)
  if (absent.length) throw Error(`Refusing ${stage}: decisions not chosen: ${absent.join(', ')}`)
  if (pending.length) throw Error(`Refusing ${stage}: decisions not approved in the config file: ${pending.join(', ')}`)
}
// Role address map: mainnet roles are code-pinned; local-test roles come from the config.
export function roleAddresses(config) {
  const selected = value(config, 'selectedConfig')
  if (config.network === 'mainnet-beta') return Object.freeze({ ...MAINNET_ROLES, mint: value(config, 'canaryMint'), ...(selected ? { selectedConfig: selected } : {}) })
  const roles = config.roles ?? {}
  for (const role of ['admin', 'guardian', 'treasury', 'upgrade', 'payer', 'creator']) if (!roles[role]) throw Error(`Local-test config requires role ${role}`)
  if (Object.values(roles).some(address => Object.values(MAINNET_ROLES).includes(address))) throw Error('Local-test roles must be synthetic, never production custody addresses')
  return Object.freeze({ ...roles, mint: value(config, 'canaryMint'), ...(selected ? { selectedConfig: selected } : {}) })
}
