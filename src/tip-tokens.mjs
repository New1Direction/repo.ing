import { PublicKey, SystemProgram } from '@solana/web3.js'
import { AccountState, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType, getDefaultAccountState, getEpochFee,
  getExtensionTypes, getPausableConfig, getTokenMetadata, getTransferFeeConfig, getTransferHook, unpackMint } from '@solana/spl-token'

// Curated tip allowlist. Only these mints can be tipped; every entry is pinned to its token program and decimals, and
// the live mint is re-checked at tip and payout time (tipMintCheck) so an issuer that later adds a transfer hook,
// a transfer fee, a frozen default state or a pause stops new tips instead of silently changing amounts.
//
// Adding a coin: run `node scripts/verify-tip-token.mjs <mint>` against a mainnet RPC (read-only). It prints the
// owner program, decimals, metadata and extensions and refuses mints with an active hook/fee/non-transferable flag.
// Copy its printed entry here with an `issuer` source you checked against the issuer's own site or API, add a test
// row in tests/tips.test.mjs, and deploy. Nothing else is needed: prices come from Jupiter by mint.
const SYSTEM = SystemProgram.programId.toBase58()
const SPL = TOKEN_PROGRAM_ID.toBase58()
const T22 = TOKEN_2022_PROGRAM_ID.toBase58()
// Backed Finance xStocks, from https://api.xstocks.fi/api/v2/public/assets (network "Solana"), verified on mainnet
// 2026-09-29: owner Token-2022, 8 decimals, on-chain metadata name/symbol matching the issuer listing.
const xStock = (symbol, name, mint) => ({ symbol, name, mint, decimals: 8, program: T22, kind: 'xstock', issuer: 'Backed Finance (xStocks)' })
export const TIP_TOKENS = Object.freeze([
  { symbol: 'SOL', name: 'Solana', mint: NATIVE_MINT.toBase58(), decimals: 9, program: SYSTEM, kind: 'native', issuer: 'Native SOL' },
  { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, program: SPL, kind: 'stable', issuer: 'Circle' },
  xStock('SPYx', 'SP500 xStock', 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W'),
  xStock('QQQx', 'Nasdaq xStock', 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ'),
  xStock('NVDAx', 'NVIDIA xStock', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'),
  xStock('TSLAx', 'Tesla xStock', 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'),
  xStock('AAPLx', 'Apple xStock', 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp'),
  xStock('MSFTx', 'Microsoft xStock', 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX'),
  xStock('GOOGLx', 'Alphabet xStock', 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN'),
  xStock('AMZNx', 'Amazon.com xStock', 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg'),
  xStock('METAx', 'Meta xStock', 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'),
].map(Object.freeze))

export const TIP_MIN_USD = 5
export const SYSTEM_PROGRAM = SYSTEM
const MAX_U64 = (1n << 64n) - 1n

export function tipToken(mint) {
  const token = TIP_TOKENS.find(t => t.mint === mint)
  if (!token) throw Error('This token is not accepted for tips')
  return token
}
export const isNativeTip = token => token.program === SYSTEM

// Smallest base-unit amount worth at least TIP_MIN_USD at `usdPrice` per whole token. No price: no tips in that token.
export function minimumTipBaseUnits(token, usdPrice) {
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) throw Error('Token price is unavailable; tips in this token are paused')
  const units = Math.ceil(TIP_MIN_USD / usdPrice * 10 ** token.decimals)
  if (!Number.isSafeInteger(units) || units <= 0) throw Error('Token price is unavailable; tips in this token are paused')
  return BigInt(units)
}

export function parseTipAmount(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw Error('Invalid tip amount')
  const amount = BigInt(value)
  if (amount > MAX_U64) throw Error('Invalid tip amount')
  return amount
}

export function assertTipAmount(token, amount, usdPrice) {
  const minimum = minimumTipBaseUnits(token, usdPrice)
  if (amount < minimum) throw Object.assign(Error(`Tips start at $${TIP_MIN_USD}`), { minimum })
  return minimum
}

export const tipUsdValue = (token, amount, usdPrice) =>
  Number.isFinite(usdPrice) && usdPrice > 0 ? Number(amount) / 10 ** token.decimals * usdPrice : null

// Rejects any mint state that could change what the tip wallet receives or pays out, or block the transfer outright.
// `epoch` is the current epoch (transfer fees are epoch-scheduled; both the older and newer schedule must be zero).
export function tipMintCheck(token, info, epoch) {
  if (isNativeTip(token)) return { ok: true, extensions: [] }
  if (!info) throw Error('Token mint account is unavailable')
  const program = new PublicKey(token.program)
  if (!info.owner.equals(program)) throw Error('Token mint moved to a different token program')
  const mint = unpackMint(new PublicKey(token.mint), info, program)
  if (!mint.isInitialized || mint.decimals !== token.decimals) throw Error('Token mint decimals changed')
  const types = token.program === T22 ? getExtensionTypes(mint.tlvData) : []
  const names = types.map(t => ExtensionType[t] ?? String(t))
  const hook = getTransferHook(mint)
  if (hook && !hook.programId.equals(PublicKey.default)) throw Error('Token has an active transfer hook')
  const fee = getTransferFeeConfig(mint)
  if (fee) {
    const current = getEpochFee(fee, BigInt(epoch))
    if (fee.olderTransferFee.transferFeeBasisPoints || fee.newerTransferFee.transferFeeBasisPoints ||
      current.transferFeeBasisPoints || current.maximumFee > 0n) throw Error('Token has an active transfer fee')
  }
  if (types.includes(ExtensionType.NonTransferable)) throw Error('Token is non-transferable')
  const state = getDefaultAccountState(mint)
  if (state && state.state !== AccountState.Initialized) throw Error('Token accounts start frozen')
  const pause = getPausableConfig(mint)
  if (pause?.paused) throw Error('Token transfers are paused by the issuer')
  return { ok: true, extensions: names, mint }
}

export async function checkTipMint(connection, token, commitment = 'confirmed') {
  if (isNativeTip(token)) return { ok: true, extensions: [] }
  const [info, epoch] = await Promise.all([connection.getAccountInfo(new PublicKey(token.mint), commitment), connection.getEpochInfo(commitment)])
  return tipMintCheck(token, info, epoch.epoch)
}

// Read-only helper for scripts/verify-tip-token.mjs: live facts about a candidate mint.
export async function describeTipMint(connection, mintAddress) {
  const key = new PublicKey(mintAddress)
  const info = await connection.getAccountInfo(key, 'finalized')
  if (!info) throw Error('Mint account not found')
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : info.owner.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : null
  if (!program) throw Error(`Not a token mint (owner ${info.owner.toBase58()})`)
  const mint = unpackMint(key, info, program)
  let metadata = null
  if (program.equals(TOKEN_2022_PROGRAM_ID)) metadata = await getTokenMetadata(connection, key, 'finalized', program).catch(() => null)
  const epoch = (await connection.getEpochInfo('finalized')).epoch
  let check
  try { check = { ok: tipMintCheck({ mint: mintAddress, program: program.toBase58(), decimals: mint.decimals }, info, epoch).ok } }
  catch (error) { check = { ok: false, reason: error.message } }
  return { mint: mintAddress, program: program.toBase58(), decimals: mint.decimals,
    extensions: program.equals(TOKEN_2022_PROGRAM_ID) ? getExtensionTypes(mint.tlvData).map(t => ExtensionType[t] ?? String(t)) : [],
    name: metadata?.name ?? null, symbol: metadata?.symbol ?? null, supply: mint.supply.toString(),
    freezeAuthority: mint.freezeAuthority?.toBase58() ?? null, check }
}

// USD per whole token (10^decimals base units) from Jupiter's price API. Token-2022 scaled-UI mints (xStocks) quote
// usdPrice per scaled UI unit; usdPricePrescaled is the price of the raw amount the chain actually moves.
// Missing or invalid prices are omitted, which pauses tips in that token rather than guessing.
const PRICE_URL = 'https://lite-api.jup.ag/price/v3?ids='
const PRICE_TTL_MS = 60_000
let priceCache = { at: 0, prices: null }
export function readJupiterPrices(body, mints = TIP_TOKENS.map(t => t.mint)) {
  const prices = {}
  for (const mint of mints) {
    const row = body?.[mint]
    const price = Number(row?.scaledUiConfig?.usdPricePrescaled ?? row?.usdPrice)
    if (Number.isFinite(price) && price > 0) prices[mint] = price
  }
  return prices
}
export async function tipTokenPrices({ fetcher = globalThis.fetch, now = Date.now } = {}) {
  if (priceCache.prices && now() - priceCache.at < PRICE_TTL_MS) return priceCache.prices
  try {
    const response = await fetcher(PRICE_URL + TIP_TOKENS.map(t => t.mint).join(','), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) })
    if (!response.ok) throw Error(`price HTTP ${response.status}`)
    const prices = readJupiterPrices(await response.json())
    priceCache = { at: now(), prices }
    return prices
  } catch {
    // An expired price is never reused for minimums; a failed lookup refuses tips until the next success.
    return {}
  }
}
export function clearTipPriceCache() { priceCache = { at: 0, prices: null } }
