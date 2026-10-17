// Public contract only. Parsing an intent is not preparation, policy approval or spending consent.
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'

export const HOOK_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const hookAddress = z.string().max(44).refine(value => {
  try { return new PublicKey(value).toBase58() === value } catch { return false }
})
export const hookDigest = z.string().regex(/^[a-f0-9]{64}$/)
export const hookRawAmount = z.string().regex(/^(0|[1-9]\d{0,19})$/)
  .pipe(z.string().refine(value => BigInt(value) <= 0xffffffffffffffffn))
const positive = hookRawAmount.refine(value => BigInt(value) > 0n)
const context = z.object({ genesisHash: z.literal(HOOK_MAINNET_GENESIS),
  profileSha256: hookDigest, policySha256: hookDigest, quoteMint: hookAddress,
  quoteDecimals: z.number().int().min(0).max(18),
}).strict()
const common = { schema: z.literal('repoing/hook-execution-intent/1'), id: z.uuid(),
  // Expected pins are optimistic concurrency assertions, never client authority.
  expectedContext: context, wallet: hookAddress, mint: hookAddress, feePayer: hookAddress,
  maxNetworkFeeLamports: hookRawAmount, maxTotalDebitLamports: positive,
}
const plainRecipe = z.object({ schemaVersion: z.literal('repo-ing/hook-lab-recipe/1'),
  recipe: z.object({ format: z.literal('hook-lab/1'),
    coin: z.object({ name: z.string().min(1).max(32), ticker: z.string().min(1).max(10) }).strict(),
    blocks: z.array(z.never()).length(0),
  }).strict(),
}).strict()
export const hookExecutionIntentSchema = z.discriminatedUnion('operation', [
  z.object({ ...common, operation: z.literal('create-plain'), recipe: plainRecipe,
    virtualQuoteRaw: positive, maxRentLamports: hookRawAmount, maxProgramFeeLamports: hookRawAmount,
  }).strict(),
  z.object({ ...common, operation: z.enum(['buy', 'sell']), pool: hookAddress,
    amountInRaw: positive, minAmountOutRaw: positive,
  }).strict(),
])

export function hookExecutionContract() {
  return { schema: 'repoing/hook-execution-contract/1', status: 'scaffolding-only',
    intentSchema: 'repoing/hook-execution-intent/1', network: 'mainnet-beta', genesisHash: HOOK_MAINNET_GENESIS,
    activeProfile: null, plainIsCustomHook: false,
    capabilities: { prepare: false, simulate: false, sign: false, submit: false, buy: false, sell: false,
      recover: false, index: false, nonzeroProtocolAccrual: false, collectorSettlement: false,
      creatorSplit: false, graduate: false, customHook: false },
    rejectedFormats: ['repoing-playground/1', 'repoing-playground-draft/1'],
    recovery: { identity: ['authenticatedOwner', 'genesisHash', 'profileSha256', 'mint', 'messageSha256'],
      retainPartialSignatures: true, retainFirstFinalized: true, automaticRetry: false, replacementMint: false },
    evidenceLevels: ['raw-finalized-transaction', 'decoded-event', 'economic-postconditions', 'adopted-deployment'],
    blockers: ['No adopted production preparation service or history decoder.',
      'Nonzero protocol accrual, collector settlement and graduation have no accepted mainnet receipts.',
      'Deployed plain-only restrictions require a separately reviewed launch/swap release for custom Hooks.'],
  }
}
