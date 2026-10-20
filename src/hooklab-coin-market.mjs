// Read-only market view of one Hooks coin for display: curve reserves, price, progress to graduation (or what graduation
// did), the coin's wallet cap and creator fee, and (optionally) a wallet's SOL and Hook Lab balances. Not trade authority: every trade and funding
// review re-reads and re-verifies state on two providers before anything is signed.
import { PublicKey } from '@solana/web3.js'
import { loadArtifacts } from './hooklab-owner-driver/artifacts.mjs'
import { holdingAddress } from './hooklab-owner-driver/pins.mjs'
import { hookCoinAddresses } from './hooklab-inclusive-max-wallet-swap.mjs'
import { STATUS_GRADUATED, finalFillLamports, graduationOutcome, isReady } from './hooklab-graduation.mjs'
import { NATIVE_FLAGS } from './hooklab-native-pins.mjs'
import { selectedHookSchema } from './hooklab-selected-hook.mjs'

const s = value => value.toString()
const holdingAmount = info => info && Buffer.from(info.data).length === 204 ? Buffer.from(info.data).readBigUInt64LE(74) : null

// profile: the coin's stack profile (its programs and quote marker); the trade runtime picks it by the coin's stack.
export async function readHookCoinMarket({ connection, mint, wallet = null, profile, selectedHook = null }) {
  if (!profile?.programs || !profile.quoteMint) throw Error('The coin\'s stack profile is required')
  new PublicKey(mint); if (wallet) new PublicKey(wallet)
  const { coders } = loadArtifacts(), a = hookCoinAddresses(profile, mint), T = profile.programs.token
  const walletKeys = wallet ? [wallet, holdingAddress(profile.quoteMint, wallet, T), holdingAddress(mint, wallet, T)] : []
  const keys = [a.launch, a.pool, a.policy, mint, a.launchReserve, a.launchLp, ...walletKeys]
  const { value, context } = await connection.getMultipleAccountsInfoAndContext(keys.map(k => new PublicKey(k)), { commitment: 'confirmed' })
  const [launchInfo, poolInfo, policyInfo, mintInfo] = value
  if (!launchInfo || !poolInfo || (!selectedHook && !policyInfo) || !mintInfo) return null
  const owned = (info, program) => info.owner.toBase58() === program
  if (!owned(launchInfo, profile.programs.launch) || !owned(poolInfo, profile.programs.swap) || (!selectedHook && !owned(policyInfo, profile.programs.gate)) || !owned(mintInfo, T)) return null
  const launch = coders.launch.accounts.decode('Launch', launchInfo.data), pool = coders.swap.accounts.decode('Pool', poolInfo.data)
  const policy = selectedHook ? null : coders.gate.accounts.decode('PolicyV2', policyInfo.data), coin = coders.token.accounts.decode('Mint', mintInfo.data)
  if (launch.mint.toBase58() !== mint || pool.base_mint.toBase58() !== mint || (policy && policy.mint.toBase58() !== mint)) return null
  if(selectedHook){
    selectedHook=selectedHookSchema.parse(selectedHook)
    if(selectedHook.program===profile.programs.gate||launch.custom_hook?.toBase58()!==selectedHook.program||launch.custom_hook_flags!==selectedHook.flags
      ||coin.hook_program?.toBase58()!==selectedHook.program||coin.hook_flags!==selectedHook.flags||pool.fee_model!==2)return null
  }
  const capBps=selectedHook?0:policy.cap_bps,creatorFeeBps=selectedHook?launch.creator_fee_bps:policy.creator_fee_bps
  const initialSupply=selectedHook?s(coin.max_supply):s(policy.initial_supply)
  // The native-SOL flags, at the bytes the programs read (32 earlier without a hook). A coin is native only when both
  // say so; any other pair (a half-migrated or unknown state) is a mismatch, and nothing offers to trade it.
  // Display only, from the primary provider: every review re-reads both flags on two providers. If this provider were
  // wrong, the worst case is a native coin shown as bridged, whose Add SOL deposit stays withdrawable while the bridged
  // review refuses the trade; a bridged coin shown as native is refused by the native review before anything moves.
  const flag = (info, hooked, at, without) => Buffer.from(info.data)[hooked ? at : without]
  const poolFlag = flag(poolInfo, !!pool.hook_program, NATIVE_FLAGS.pool, NATIVE_FLAGS.poolWithoutHook)
  const launchFlag = flag(launchInfo, !!launch.custom_hook, NATIVE_FLAGS.launch, NATIVE_FLAGS.launchWithoutHook)
  const native = poolFlag === 1 && launchFlag === 1, quoteFormMismatch = !native && !(poolFlag === 0 && launchFlag === 0)
  const base = BigInt(s(pool.base_reserve)) + BigInt(s(pool.virtual_base)), quote = BigInt(s(pool.quote_reserve)) + BigInt(s(pool.virtual_quote))
  const decimals = coin.decimals, graduation = BigInt(s(launch.graduation_quote)), quoteReserve = BigInt(s(pool.quote_reserve))
  // Status 1 is what the max-wallet gate reads (Launch byte 138) to stop capping; graduate sets it with graduated_at.
  const graduated = launch.status === STATUS_GRADUATED, [reserveHolding, lpHolding] = value.slice(4, 6).map(holdingAmount)
  const view = {
    mint, name: coin.name, symbol: coin.symbol, uri: coin.uri, decimals, observedSlot: context.slot,
    selectedConfig: launch.config.toBase58(), creator: launch.creator.toBase58(), graduated, native, quoteFormMismatch,
    // supply: the mint's current supply (graduation burns some), the figure the market cap below and the chart's use.
    capBps, creatorFeeBps, initialSupply, supply: s(coin.supply),
    capRaw: selectedHook?null:s(BigInt(initialSupply) * BigInt(capBps) / 10000n),
    ...(selectedHook?{policyKind:'selected-hook',selectedHook}:{}),
    pool: { baseReserve: s(pool.base_reserve), quoteReserve: s(pool.quote_reserve), virtualBase: s(pool.virtual_base),
      virtualQuote: s(pool.virtual_quote), protocolFeesQuote: s(pool.protocol_fees_quote), swapCount: s(pool.swap_count) },
    // The whole supply (less what graduation burned) valued at the current price, in lamports (no fee).
    marketCapLamports: base > 0n ? s(quote * BigInt(s(coin.supply)) / base) : '0',
    graduationQuote: s(graduation), reserveTokens: s(launch.reserve_tokens),
    curveProgressBps: graduated ? 10000 : graduation > 0n ? Number(quoteReserve >= graduation ? 10000n : quoteReserve * 10000n / graduation) : 0,
  }
  // solToGraduationLamports: what a buy costs right now to finish the curve (creator fee included), null once it is
  // complete or has no exact fill. graduation: after it, what graduate did (from the launch and its LP holding, which no
  // instruction can move); while a full curve waits, what graduate will do with the reserve it holds now.
  const curveComplete = !graduated && isReady(view.pool, graduation), fill = finalFillLamports(view)
  const outcome = curveComplete && reserveHolding !== null ? graduationOutcome(view.pool, reserveHolding) : null
  const market = { ...view, curveComplete, solToGraduationLamports: fill === null ? null : s(fill),
    graduation: graduated ? { at: Number(s(launch.graduated_at)), topup: s(launch.graduation_topup), burned: s(launch.graduation_burned), lockedLp: s(lpHolding ?? 0n), lpSupply: s(pool.lp_supply) }
      : outcome ? { at: null, topup: s(outcome.topup), burned: s(outcome.burned), lockedLp: s(outcome.lockedLp), lpSupply: s(outcome.lpSupply),
        baseReserve: s(outcome.pool.baseReserve), quoteReserve: s(outcome.pool.quoteReserve) } : null }
  if (!wallet) return { market, wallet: null }
  const [walletInfo, quoteHolding, coinHolding] = value.slice(6), coinAmount = holdingAmount(coinHolding)?.toString() ?? null
  // A native coin trades straight from the wallet's SOL, so its view has no bridged SOL in it.
  if (native) return { market, wallet: { address: wallet, lamports: s(walletInfo?.lamports ?? 0), coin: coinAmount } }
  return { market, wallet: { address: wallet, lamports: s(walletInfo?.lamports ?? 0),
    bridgedSol: holdingAmount(quoteHolding)?.toString() ?? null, coin: coinAmount } }
}

// A wallet's SOL and its bridged SOL in Hook Lab (null when the bridged-SOL holding does not exist yet). Legacy stack only
// (profile: bundle 2's): our own stack has no bridged SOL.
export async function readHookWalletBalances({ connection, wallet, profile }) {
  if (!profile?.programs?.bridge) throw Error('Bridged balances exist on the legacy stack only')
  new PublicKey(wallet)
  const keys = [wallet, holdingAddress(profile.quoteMint, wallet, profile.programs.token)]
  const { value } = await connection.getMultipleAccountsInfoAndContext(keys.map(k => new PublicKey(k)), { commitment: 'confirmed' })
  return { address: wallet, lamports: String(value[0]?.lamports ?? 0), bridgedSol: holdingAmount(value[1])?.toString() ?? null }
}
