// Candidate-only, offline preparation. Never imports a connection, wallet or transaction builder.
import { z } from 'zod'
import { PublicKey } from '@solana/web3.js'
import { hardenedCandidateManifest, mainnetLaunchAddresses, quoteLaunchSwap,
  creatorAuthorizationAddress, creationControlHash } from '@repo-ing/hooklab-hardened-candidate'

export const HARDENED_SOURCE = '826b5a480dfafbe9395f9e9b9c280d07fc7eb809'
export const HARDENED_MANIFEST_SHA256 = '4352214b2194a70e45f0b2cf16e10e2a62c29b947574b41a5caeff749c9d87f0'
export const hardenedU64 = z.string().regex(/^(0|[1-9]\d*)$/).refine(v => BigInt(v) <= 0xffffffffffffffffn)
export const hardenedKey = z.string().refine(v => { try { return new PublicKey(v).toBase58() === v } catch { return false } })
const bps = z.number().int().min(0).max(10000)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const big = value => BigInt(hardenedU64.parse(value))
const json = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v))

export function hardenedReadiness() {
  const proposal = hardenedCandidateManifest()
  return {
    schema: 'repoing/hardened-readiness/1', sourceCommit: HARDENED_SOURCE, manifestSha256: HARDENED_MANIFEST_SHA256,
    status: 'offline-candidate', network: 'devnet', genesisHash: proposal.genesisHash,
    proposedPrograms: proposal.programs, observedSlot: null, deploymentVerified: false,
    // Artifact hashes, NOT observed on-chain code or verified signing attestations.
    proposedElfSha256: { launch: '9db2ab27f7a962c44a5a679fb2616d66fcff1bd5ceb2fa418978675d6e575f55',
      swap: 'b408043266014f182426c54b51dc9fd591b070cd490f6c3706367d595736810d' },
    actions: { launch: false, buy: false, sell: false, simulate: false, review: false, sign: false, submit: false },
    recovery: 'journal-only; no hardened chain receipt verifier',
    blockers: ['deployment-and-dependencies', 'governance-and-custody', 'approved-economics-and-budgets',
      'signed-devnet-acceptance', 'wallet-and-receipt-verification', 'migration-backup-and-activation'],
  }
}

// There is intentionally no environment flag, request boolean or manifest field that enables this.
export function refuseHardenedExecution() {
  throw Object.assign(new Error('Hardened launch, buy, sell, simulation, review, signing and submission are disabled pending reviewed deployment and separate activation.'),
    { status: 423, code: 'HARDENED_EXECUTION_DISABLED' })
}

/** Explicit proposed profile on EVERY address/hash helper; no legacy SDK defaults leak out. */
export function hardenedLaunchIdentity(input) {
  const p = z.object({ creator: hardenedKey, mint: hardenedKey, quoteMint: hardenedKey,
    lpFeeBps: bps, governanceCommitment: hash,
    authorization: z.object({ enabled: z.boolean(), expiresAtSlot: hardenedU64,
      maxLaunches: hardenedU64, consumed: hardenedU64, revision: hardenedU64 }).strict(),
  }).strict().parse(input)
  const manifest = hardenedCandidateManifest()
  if (p.quoteMint !== manifest.quoteMint) throw new Error('Unsupported candidate quote mint')
  const programs = { launch: new PublicKey(manifest.programs.launch), swap: new PublicKey(manifest.programs.swap) }
  const creator = new PublicKey(p.creator)
  const auth = { ...p.authorization, creator, expiresAtSlot: big(p.authorization.expiresAtSlot),
    maxLaunches: big(p.authorization.maxLaunches), consumed: big(p.authorization.consumed), revision: big(p.authorization.revision) }
  return { status: 'offline-only', authorization: creatorAuthorizationAddress(creator, programs.launch).toBase58(),
    addresses: Object.fromEntries(Object.entries(mainnetLaunchAddresses(new PublicKey(p.mint), new PublicKey(p.quoteMint), p.lpFeeBps, programs)).map(([k, v]) => [k, v.toBase58()])),
    controlHash: creationControlHash(Buffer.from(p.governanceCommitment, 'hex'), auth, programs.launch).toString('hex'),
    canSign: false, canSubmit: false }
}

/** Hypothetical plain-pool arithmetic only. Caller-supplied reserves/effective fee are NOT chain evidence.
 * No clock/sniper/recipient resolution, wallet balances, live quotes, trade builder or RPC is implied.
 */
export function previewHardenedTrade(input) {
  const p = z.object({ schema: z.literal('repoing/hardened-trade-model/1'), side: z.enum(['buy', 'sell']),
    amountIn: hardenedU64, maxInput: hardenedU64, slippageBps: bps.refine(v => v < 10000),
    reserves: z.object({ baseReserve: hardenedU64, quoteReserve: hardenedU64,
      virtualBase: hardenedU64, virtualQuote: hardenedU64 }).strict(),
    effectiveLpFeeBps: bps, protocolShareBps: bps,
    budget: z.object({ rentLamports: hardenedU64, networkFeeLamports: hardenedU64,
      computeUnitLimit: z.number().int().positive().max(1400000), computeUnitPriceMicroLamports: hardenedU64,
      maxNativeDebitLamports: hardenedU64 }).strict(),
  }).strict().parse(input)
  const amount = big(p.amountIn), reserves = Object.fromEntries(Object.entries(p.reserves).map(([k, v]) => [k, big(v)]))
  if (!amount || amount > big(p.maxInput)) throw new Error('Input outside requested cap')
  if (reserves.baseReserve + reserves.virtualBase > 0xffffffffffffffffn
    || reserves.quoteReserve + reserves.virtualQuote > 0xffffffffffffffffn) throw new Error('Reserve sum outside u64')
  const quote = quoteLaunchSwap(reserves, p.side, amount, p.effectiveLpFeeBps, p.protocolShareBps,
    { creatorFeeBps: 0, holderFeeBuyBps: 0, holderFeeSellBps: 0, burnBuyBps: 0, burnSellBps: 0, eligible: 0n, minEligible: 1n })
  const priority = (BigInt(p.budget.computeUnitLimit) * big(p.budget.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  const native = big(p.budget.rentLamports) + big(p.budget.networkFeeLamports) + priority
  const minimumOutput = quote.delivered === null ? null : quote.delivered * BigInt(10000 - p.slippageBps) / 10000n
  return json({ schema: 'repoing/hardened-trade-model-result/1', sourceCommit: HARDENED_SOURCE,
    manifestSha256: HARDENED_MANIFEST_SHA256, status: 'hypothetical-not-a-live-quote', side: p.side,
    inputAsset: p.side === 'buy' ? 'Hook Lab custom quote token; not native SOL' : 'base token',
    quote, minimumOutput, nativeBudget: { priorityFeeLamports: priority, totalLamports: native },
    refusals: [quote.failure, minimumOutput === 0n ? 'zero-minimum-output' : null,
      native > big(p.budget.maxNativeDebitLamports) ? 'native-cap-exceeded' : null].filter(Boolean),
    canSimulate: false, canReview: false, canSign: false, canSubmit: false })
}
