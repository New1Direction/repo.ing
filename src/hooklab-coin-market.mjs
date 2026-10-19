// Read-only market view of one Hooks coin for display: curve reserves, price, progress, the coin's wallet cap and
// creator fee, and (optionally) a wallet's SOL and Hook Lab balances. Not trade authority: every trade and funding
// review re-reads and re-verifies state on two providers before anything is signed.
import { PublicKey } from '@solana/web3.js'
import { loadArtifacts } from './hooklab-owner-driver/artifacts.mjs'
import { PROGRAMS, QUOTE_MINT, holdingAddress } from './hooklab-owner-driver/pins.mjs'
import { hookCoinAddresses } from './hooklab-inclusive-max-wallet-swap.mjs'

const s = value => value.toString()
const holdingAmount = info => info && Buffer.from(info.data).length === 204 ? Buffer.from(info.data).readBigUInt64LE(74) : null

export async function readHookCoinMarket({ connection, mint, wallet = null, profile = { programs: PROGRAMS, quoteMint: QUOTE_MINT } }) {
  new PublicKey(mint); if (wallet) new PublicKey(wallet)
  const { coders } = loadArtifacts(), a = hookCoinAddresses(profile, mint), T = profile.programs.token
  const walletKeys = wallet ? [wallet, holdingAddress(profile.quoteMint, wallet, T), holdingAddress(mint, wallet, T)] : []
  const keys = [a.launch, a.pool, a.policy, mint, ...walletKeys]
  const { value, context } = await connection.getMultipleAccountsInfoAndContext(keys.map(k => new PublicKey(k)), { commitment: 'confirmed' })
  const [launchInfo, poolInfo, policyInfo, mintInfo] = value
  if (!launchInfo || !poolInfo || !policyInfo || !mintInfo) return null
  const owned = (info, program) => info.owner.toBase58() === program
  if (!owned(launchInfo, profile.programs.launch) || !owned(poolInfo, profile.programs.swap) || !owned(policyInfo, profile.programs.gate) || !owned(mintInfo, T)) return null
  const launch = coders.launch.accounts.decode('Launch', launchInfo.data), pool = coders.swap.accounts.decode('Pool', poolInfo.data)
  const policy = coders.gate.accounts.decode('PolicyV2', policyInfo.data), coin = coders.token.accounts.decode('Mint', mintInfo.data)
  if (launch.mint.toBase58() !== mint || pool.base_mint.toBase58() !== mint || policy.mint.toBase58() !== mint) return null
  const base = BigInt(s(pool.base_reserve)) + BigInt(s(pool.virtual_base)), quote = BigInt(s(pool.quote_reserve)) + BigInt(s(pool.virtual_quote))
  const decimals = coin.decimals, graduation = BigInt(s(launch.graduation_quote)), quoteReserve = BigInt(s(pool.quote_reserve))
  const market = {
    mint, name: coin.name, symbol: coin.symbol, uri: coin.uri, decimals, observedSlot: context.slot,
    selectedConfig: launch.config.toBase58(), creator: launch.creator.toBase58(), graduated: !launch.graduated_at.isZero(),
    capBps: policy.cap_bps, creatorFeeBps: policy.creator_fee_bps, initialSupply: s(policy.initial_supply),
    capRaw: s(BigInt(s(policy.initial_supply)) * BigInt(policy.cap_bps) / 10000n),
    pool: { baseReserve: s(pool.base_reserve), quoteReserve: s(pool.quote_reserve), virtualBase: s(pool.virtual_base),
      virtualQuote: s(pool.virtual_quote), protocolFeesQuote: s(pool.protocol_fees_quote), swapCount: s(pool.swap_count) },
    // The whole supply valued at the current curve price, in lamports (no fee).
    marketCapLamports: s(quote * BigInt(s(policy.initial_supply)) / base),
    graduationQuote: s(graduation), curveProgressBps: graduation > 0n ? Number(quoteReserve * 10000n / graduation) : 0,
  }
  if (!wallet) return { market, wallet: null }
  const [walletInfo, quoteHolding, coinHolding] = value.slice(4)
  return { market, wallet: { address: wallet, lamports: s(walletInfo?.lamports ?? 0),
    bridgedSol: holdingAmount(quoteHolding)?.toString() ?? null, coin: holdingAmount(coinHolding)?.toString() ?? null } }
}

// A wallet's SOL and its bridged SOL in Hook Lab (null when the bridged-SOL holding does not exist yet).
export async function readHookWalletBalances({ connection, wallet, profile = { programs: PROGRAMS, quoteMint: QUOTE_MINT } }) {
  new PublicKey(wallet)
  const keys = [wallet, holdingAddress(profile.quoteMint, wallet, profile.programs.token)]
  const { value } = await connection.getMultipleAccountsInfoAndContext(keys.map(k => new PublicKey(k)), { commitment: 'confirmed' })
  return { address: wallet, lamports: String(value[0]?.lamports ?? 0), bridgedSol: holdingAmount(value[1])?.toString() ?? null }
}
