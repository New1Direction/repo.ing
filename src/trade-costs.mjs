import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ACCOUNT_SIZE, NATIVE_MINT, getAccountLenForMint,
  getAssociatedTokenAddressSync, unpackMint } from '@solana/spl-token'
import { tradePriorityFee } from './trade-landing.mjs'
import { QUOTE_REGISTRY } from './quote-assets.mjs'

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
export async function estimateTradeCosts(connection, prepared) {
  const tx = prepared.transaction, payer = tx.feePayer
  const quoteMint = prepared.quoteMint ? new PublicKey(prepared.quoteMint) : null
  const creations = tx.instructions.filter(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
  const stockAccount = ix => Boolean(quoteMint) && ix.keys[3]?.pubkey.equals(quoteMint) && ix.keys[5]?.pubkey.equals(TOKEN_2022_PROGRAM_ID)
  for (const ix of creations) {
    if (ix.data.length !== 1 || ix.data[0] !== 1 || !ix.keys[0]?.pubkey.equals(payer) ||
        !ix.keys[2]?.pubkey.equals(payer) || !(ix.keys[5]?.pubkey.equals(TOKEN_PROGRAM_ID) || stockAccount(ix))) {
      throw Error('Account setup estimate unavailable for this transaction')
    }
  }
  const quoteAccount = quoteMint ? getAssociatedTokenAddressSync(quoteMint, payer, false, TOKEN_2022_PROGRAM_ID) : null
  const [balance, fee, rent, existing, stockRent, quoteHeld] = await Promise.all([
    connection.getBalance(payer, 'confirmed'),
    connection.getFeeForMessage(tx.compileMessage(), 'confirmed'),
    creations.length ? connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE) : 0,
    creations.length ? connection.getMultipleAccountsInfo(creations.map(ix => ix.keys[1].pubkey), 'confirmed') : [],
    creations.some(stockAccount) ? stockAccountRent(connection, quoteMint) : 0,
    quoteAccount ? connection.getTokenAccountBalance(quoteAccount, 'confirmed').then(result => result.value.amount, () => '0') : null,
  ])
  let accountDeposits = 0n, refundableDeposit = 0n
  creations.forEach((ix, i) => {
    const account = existing[i]
    if (account?.owner.equals(TOKEN_PROGRAM_ID) || (stockAccount(ix) && account?.owner.equals(TOKEN_2022_PROGRAM_ID))) return
    const needed = integer(stockAccount(ix) ? stockRent : rent) - integer(account?.lamports ?? 0)
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
  const spend = prepared.direction === 'buy' ? BigInt(prepared.amountIn) : 0n, held = BigInt(quoteHeld)
  return { ...costs, quoteMint: quoteMint.toBase58(), quoteBalance: String(held), quoteShortfall: String(spend > held ? spend - held : 0n) }
}

// Rent for the wallet's Token-2022 account of a stock: the account size its mint's extensions require.
async function stockAccountRent(connection, mint) {
  const info = await connection.getAccountInfo(mint, 'confirmed')
  if (!info?.owner.equals(TOKEN_2022_PROGRAM_ID)) throw Error('Account setup estimate unavailable for this transaction')
  return connection.getMinimumBalanceForRentExemption(getAccountLenForMint(unpackMint(mint, info, TOKEN_2022_PROGRAM_ID)))
}

export async function preflightTrade(connection, prepared, costs) {
  if (BigInt(costs.quoteShortfall ?? '0') > 0n) {
    const asset = QUOTE_REGISTRY.assets.find(candidate => candidate.mint === costs.quoteMint)
    const scale = 10 ** (asset?.decimals ?? 0)
    throw Error(`You need approximately ${(Number(BigInt(costs.quoteShortfall)) / scale).toFixed(Math.min(asset?.decimals ?? 0, 6))} more ${asset?.symbol ?? 'of the quote token'}.`)
  }
  if (BigInt(costs.shortfall) > 0n) {
    const amount = (BigInt(costs.shortfall) + 999n) / 1000n
    throw Error(`You need approximately ${(Number(amount) / 1e6).toFixed(6)} more SOL, including fees and refundable account deposits.`)
  }
  const encoded = prepared.transaction.serialize({ requireAllSignatures: false, verifySignatures: false })
  const { value } = await connection.simulateTransaction(VersionedTransaction.deserialize(encoded), {
    commitment: 'confirmed', sigVerify: false,
  })
  if (value.err) throw Error('Trade simulation did not pass. Refresh the quote and check your wallet balance before trying again.')
}
