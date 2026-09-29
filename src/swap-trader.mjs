// The wallet a finalized swap is attributed to, for per-wallet P&L only (never for fees or settlement).
// DBC and DAMM swaps name their user as the `payer` account (DBC index 9, DAMM index 8). A direct swap
// signs with that wallet. Aggregators may route through a program-owned authority that signs by CPI and
// is not a transaction signer; such a swap is attributed to the transaction fee payer (account 0), the
// wallet that submitted and paid for the route. Loaded (ALT) addresses are never signers.
export const DBC_SWAP_PAYER = 9
export const DAMM_SWAP_PAYER = 8

export function swapTrader(transaction, instruction, payerPosition) {
  const message = transaction.transaction.message, keys = message.accountKeys
  const signers = message.header?.numRequiredSignatures ?? 1
  const index = instruction?.accounts?.[payerPosition]
  const key = Number.isInteger(index) && index < signers ? keys[index] : keys[0]
  if (!key) throw Error('SWAP_TRADER_MISSING')
  return key.toBase58()
}
