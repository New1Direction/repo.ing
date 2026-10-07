import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ACCOUNT_SIZE, NATIVE_MINT, ExtensionType, getAccountLen,
  getAssociatedTokenAddressSync, getExtensionTypes, unpackAccount, unpackMint } from '@solana/spl-token'
import { tradePriorityFee } from './trade-landing.mjs'
import { QUOTE_REGISTRY } from './quote-assets.mjs'
import { stockMultiplier } from './quote-asset-info.mjs'
import { parseMultiplier, shownRoundedUp } from './scaled-ui-amount.mjs'
import { hookRefusal } from './early-access-trade.mjs'

const LAMPORTS_PER_SIGNATURE = 5000n

const integer = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('Network cost estimate unavailable')
  return BigInt(value)
}

// The current DBC swap creates standard SPL accounts, then closes its wrapped
// SOL account. Temporary rent is needed up front, but is not a trading expense.
// A stock-paired trade (prepared.quoteMint, docs/STOCK_QUOTES.md) wraps nothing: it may also create the wallet's Token-2022
// account for the stock, whose size follows the stock mint's extensions; the stock it spends is checked separately
// (quoteBalance, quoteShortfall), and SOL pays only the network fee and account rent.
// A contributor early access market's token is Token-2022 (docs/EARLY_ACCESS.md): the wallet's associated account for it is sized
// by the mint's extensions (its transfer hook adds one) like a stock's.
export async function estimateTradeCosts(connection, prepared) {
  const tx = prepared.transaction, payer = tx.feePayer
  const quoteMint = prepared.quoteMint ? new PublicKey(prepared.quoteMint) : null, mint = prepared.mint ? new PublicKey(prepared.mint) : null
  const creations = tx.instructions.filter(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
  const token2022 = forMint => ix => Boolean(forMint) && ix.keys[3]?.pubkey.equals(forMint) && ix.keys[5]?.pubkey.equals(TOKEN_2022_PROGRAM_ID)
  const stockAccount = token2022(quoteMint)
  const marketAccount = ix => token2022(mint)(ix) && ix.keys[1]?.pubkey.equals(getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022_PROGRAM_ID))
  for (const ix of creations) {
    if (ix.data.length !== 1 || ix.data[0] !== 1 || !ix.keys[0]?.pubkey.equals(payer) ||
        !ix.keys[2]?.pubkey.equals(payer) || !(ix.keys[5]?.pubkey.equals(TOKEN_PROGRAM_ID) || stockAccount(ix) || marketAccount(ix))) {
      throw Error('Account setup estimate unavailable for this transaction')
    }
  }
  const quoteAccount = quoteMint ? getAssociatedTokenAddressSync(quoteMint, payer, false, TOKEN_2022_PROGRAM_ID) : null
  const [balance, fee, rent, existing, stockRent, marketRent, quoteHeld] = await Promise.all([
    connection.getBalance(payer, 'confirmed'),
    connection.getFeeForMessage(tx.compileMessage(), 'confirmed'),
    creations.length ? connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE) : 0,
    creations.length ? connection.getMultipleAccountsInfo(creations.map(ix => ix.keys[1].pubkey), 'confirmed') : [],
    creations.some(stockAccount) ? token2022AccountRent(connection, quoteMint) : 0,
    creations.some(marketAccount) ? token2022AccountRent(connection, mint) : 0,
    quoteAccount ? tokenAccountAmount(connection, quoteAccount, TOKEN_2022_PROGRAM_ID) : null,
  ])
  let accountDeposits = 0n, refundableDeposit = 0n
  creations.forEach((ix, i) => {
    const account = existing[i], extended = stockAccount(ix) || marketAccount(ix)
    if (account?.owner.equals(TOKEN_PROGRAM_ID) || (extended && account?.owner.equals(TOKEN_2022_PROGRAM_ID))) return
    const needed = integer(stockAccount(ix) ? stockRent : marketAccount(ix) ? marketRent : rent) - integer(account?.lamports ?? 0)
    const deposit = needed > 0n ? needed : 0n
    const closesToPayer = tx.instructions.some(close => close.programId.equals(TOKEN_PROGRAM_ID) &&
      close.data.length === 1 && close.data[0] === 9 && close.keys[0]?.pubkey.equals(ix.keys[1].pubkey) &&
      close.keys[1]?.pubkey.equals(payer))
    if (ix.keys[3].pubkey.equals(NATIVE_MINT) && closesToPayer) refundableDeposit += deposit
    else accountDeposits += deposit
  })
  // Network fee = base signature fee + priority fee (limit × price). getFeeForMessage already includes the priority
  // fee; the floor keeps the estimate whole if an RPC ever reports only the base fee.
  const priorityFee = tradePriorityFee(tx.instructions)
  const signatures = BigInt(tx.compileMessage().header.numRequiredSignatures)
  const quoted = integer(fee.value), floor = signatures * LAMPORTS_PER_SIGNATURE + priorityFee
  const networkFee = quoted > floor ? quoted : floor, walletBalance = integer(balance)
  const input = prepared.direction === 'buy' && !quoteMint ? BigInt(prepared.amountIn) : 0n
  const total = input + networkFee + accountDeposits
  const required = total + refundableDeposit
  const costs = { networkFee: String(networkFee), priorityFee: String(priorityFee), accountDeposits: String(accountDeposits),
    refundableDeposit: String(refundableDeposit), total: String(total), required: String(required),
    balance: String(walletBalance), shortfall: String(required > walletBalance ? required - walletBalance : 0n) }
  if (!quoteMint) return costs
  const spend = prepared.direction === 'buy' ? BigInt(prepared.amountIn) : 0n, held = quoteHeld
  return { ...costs, quoteMint: quoteMint.toBase58(), quoteBalance: String(held), quoteShortfall: String(spend > held ? spend - held : 0n) }
}

// Raw units held by a token account under `programId`. No account holds nothing; an RPC failure throws, because a failed
// read is never a zero balance.
export async function tokenAccountAmount(connection, account, programId) {
  const info = await connection.getAccountInfo(account, 'confirmed')
  return info && info.owner.equals(programId) ? unpackAccount(account, info, programId).amount : 0n
}

// The account extensions Token-2022 adds when an associated account for a mint is created: ImmutableOwner, plus the one each of
// these mint extensions requires. Extensions such as ConfidentialTransferAccount are added only when configured later, so they
// are not counted (a METAx account is created at 179 bytes, as on mainnet). Every other known mint extension needs nothing.
const REQUIRED_ACCOUNT_EXTENSION = new Map([[ExtensionType.TransferFeeConfig, ExtensionType.TransferFeeAmount],
  [ExtensionType.NonTransferable, ExtensionType.NonTransferableAccount], [ExtensionType.TransferHook, ExtensionType.TransferHookAccount],
  [ExtensionType.PausableConfig, ExtensionType.PausableAccount]])
const NO_ACCOUNT_EXTENSION = new Set(['MintCloseAuthority', 'DefaultAccountState', 'InterestBearingConfig', 'PermanentDelegate',
  'MetadataPointer', 'TokenMetadata', 'GroupPointer', 'TokenGroup', 'GroupMemberPointer', 'TokenGroupMember', 'ScaledUiAmountConfig',
  'ConfidentialTransferMint'].filter(name => name in ExtensionType).map(name => ExtensionType[name]))

// Bytes of a new associated account for this Token-2022 mint; an unrecognised mint extension fails the estimate.
export function associatedAccountLength(mint) {
  const extensions = getExtensionTypes(mint.tlvData)
  if (extensions.some(type => !REQUIRED_ACCOUNT_EXTENSION.has(type) && !NO_ACCOUNT_EXTENSION.has(type))) {
    throw Error('Account setup estimate unavailable for this transaction')
  }
  return getAccountLen([ExtensionType.ImmutableOwner, ...extensions.filter(type => REQUIRED_ACCOUNT_EXTENSION.has(type))
    .map(type => REQUIRED_ACCOUNT_EXTENSION.get(type))])
}

// Rent for the wallet's Token-2022 account of a mint (a stock, or an early access market's token), at the size Token-2022 creates it.
async function token2022AccountRent(connection, mint) {
  const info = await connection.getAccountInfo(mint, 'confirmed')
  if (!info?.owner.equals(TOKEN_2022_PROGRAM_ID)) throw Error('Account setup estimate unavailable for this transaction')
  return connection.getMinimumBalanceForRentExemption(associatedAccountLength(unpackMint(mint, info, TOKEN_2022_PROGRAM_ID)))
}

// A raw amount of a token with `decimals`, rounded up to at most 6 places (a shortfall is never shown smaller than it is).
export function amountRoundedUp(raw, decimals) {
  const places = Math.min(decimals, 6), step = 10n ** BigInt(decimals - places)
  const units = (raw + step - 1n) / step, scale = 10n ** BigInt(places)
  return places ? `${units / scale}.${String(units % scale).padStart(places, '0')}` : String(units)
}

export async function preflightTrade(connection, prepared, costs) {
  if (BigInt(costs.quoteShortfall ?? '0') > 0n) {
    const asset = QUOTE_REGISTRY.assets.find(candidate => candidate.mint === costs.quoteMint)
    if (!asset) throw Error('Trade simulation did not pass. Refresh the quote and check your wallet balance before trying again.')
    // In the units wallets show, as the trade panel shows it (src/scaled-ui-amount.mjs), rounded up.
    const shown = shownRoundedUp(BigInt(costs.quoteShortfall), parseMultiplier(await stockMultiplier(connection, asset)))
    throw Error(`You need approximately ${amountRoundedUp(shown, asset.decimals)} more ${asset.symbol}.`)
  }
  if (BigInt(costs.shortfall) > 0n) {
    const amount = (BigInt(costs.shortfall) + 999n) / 1000n
    throw Error(`You need approximately ${(Number(amount) / 1e6).toFixed(6)} more SOL, including fees and refundable account deposits.`)
  }
  const encoded = prepared.transaction.serialize({ requireAllSignatures: false, verifySignatures: false })
  const { value } = await connection.simulateTransaction(VersionedTransaction.deserialize(encoded), {
    commitment: 'confirmed', sigVerify: false,
  })
  // A contributor early access token's hook refusing the transfer (a buyer not on the list, a wallet limit) says so in its own words.
  if (value.err) throw Error(hookRefusal(value.logs) ?? 'Trade simulation did not pass. Refresh the quote and check your wallet balance before trying again.')
}
