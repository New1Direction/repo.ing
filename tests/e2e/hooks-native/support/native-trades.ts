// One finalized native-SOL trade checked against its receipt, for any stack (the program IDs come from stack.json):
// the inclusive fee split G = ceil(A*b/1e4), P = floor(G/4), N = G - P from the event, the exact lamport moves of the
// trader, the pool and the launch account, the settlement the site saved, and a single send.
import { expect } from 'e2e'
import type { VersionedTransactionResponse } from '@solana/web3.js'
import { control } from './stack.ts'
import type { OperationRow } from './db.ts'
import { big, events, feeSplit, holdingAddress, lamportDelta, one, receipt, verifySignatures } from './chain.ts'
import { expectSettlementIsReceipt } from './settlement.ts'

export interface TradeCoin { mint: string; launch: string; pool: string; creatorFeeBps: number }
export interface Checked { tx: VersionedTransactionResponse; gross: bigint; platform: bigint; creator: bigint }
const sends = () => control<Record<string, number>>('GET', '/rpc/sends')

/** A buy of `amount` lamports: the trader pays fee + amount (+ the coin holding's rent on a first buy), the pool gets
 * amount - N, the launch account N. rent: the exact holding rent expected, or null to read it from the receipt. */
export async function expectNativeBuy(op: OperationRow, wallet: string, coin: TradeCoin, amount: bigint, rent: bigint | null = null): Promise<Checked> {
  const tx = await receipt(op.signature as string)
  expect(tx.meta?.err).toBeNull(); verifySignatures(tx, wallet)
  const split = feeSplit(amount, BigInt(coin.creatorFeeBps)), accrued = one(events(tx), 'InclusiveCreatorFeeAccrued')
  expect([big(accrued.gross_quote), big(accrued.platform_quote), big(accrued.creator_quote)]).toEqual([split.gross, split.platform, split.creator])
  const holding = lamportDelta(tx, holdingAddress(coin.mint, wallet))
  if (rent !== null) expect(holding).toBe(rent)
  expect(lamportDelta(tx, wallet)).toBe(-(BigInt(tx.meta!.fee) + amount + holding))
  expect(lamportDelta(tx, coin.launch)).toBe(split.creator)
  expect(lamportDelta(tx, coin.pool)).toBe(amount - split.creator)
  expectSettlementIsReceipt(op, tx, split)
  expect((await sends())[op.signature as string]).toBe(1)
  return { tx, gross: split.gross, platform: split.platform, creator: split.creator }
}

/** A sale: the trader receives R (SwappedNative.quote_lamports, net) minus the network fee; X = R + G with G the split of
 * X; the pool pays R + N and the launch account receives N. */
export async function expectNativeSell(op: OperationRow, wallet: string, coin: TradeCoin): Promise<Checked & { received: bigint }> {
  const tx = await receipt(op.signature as string)
  expect(tx.meta?.err).toBeNull(); verifySignatures(tx, wallet)
  const accrued = one(events(tx), 'InclusiveCreatorFeeAccrued'), received = big(one(events(tx), 'SwappedNative').quote_lamports)
  const split = feeSplit(received + big(accrued.gross_quote), BigInt(coin.creatorFeeBps))
  expect([big(accrued.gross_quote), big(accrued.platform_quote), big(accrued.creator_quote)]).toEqual([split.gross, split.platform, split.creator])
  expect(lamportDelta(tx, wallet)).toBe(received - BigInt(tx.meta!.fee))
  expect(lamportDelta(tx, coin.launch)).toBe(split.creator)
  expect(lamportDelta(tx, coin.pool)).toBe(-(received + split.creator))
  expectSettlementIsReceipt(op, tx, split)
  expect((await sends())[op.signature as string]).toBe(1)
  return { tx, gross: split.gross, platform: split.platform, creator: split.creator, received }
}
