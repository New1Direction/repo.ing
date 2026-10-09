import bs58 from 'bs58'
import BN from 'bn.js'
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { BPS, BUNDLE_VAULT_PROGRAM_ID, STATUS, bundleAccounts, bundleAddress, decodeBundle, decodePlatform, failRaiseInstruction,
  openVaultInstruction, platformAddress, recordGraduationInstruction, routeCurveFeesInstruction, routePoolFeesInstruction, routerAddress,
  bundleErrorName, tokenAccountOf, vaultSwapCurveInstruction, vaultSwapPoolInstruction } from './bundle-vault.mjs'
import { bundleLaunchable } from './bundle-launch.mjs'
import { createBundleLauncher } from './bundle-launcher.mjs'
import { createLaunchCoordinator } from './launch-coordinator.mjs'
import { dbcSwapQuote } from './canonical-trade.mjs'
import { dammQuote } from './canonical-damm-trade.mjs'
import { readChainPoint } from './chain-clock.mjs'
import { quotePoint } from './launch-fee.mjs'
import { readPoolConfig } from './market-config.mjs'

// The worker's Bundle jobs (docs/BUNDLE_LAUNCH.md), one pass every ~30 s whenever Bundle is configured. With launches off (the
// switch or the code gate) existing bundles still move: raises fail and refund, fees route, graduation is recorded; only new
// launches wait, and the vault agent only logs:
// - the bundles table follows the chain: opening → raising once the Bundle account exists (expired if it never appears);
//   raising → failed when the raise failed; launching → launched once the market is confirmed;
// - cranks anyone may run, paid by the bundle launch signer: fail_raise for a raise past its deadline or grace period, the launch of
//   a full raise (through the launch coordinator, server-signed), open_vault after it, fee routing from the curve and after
//   graduation from the router's LP position, and record_graduation (the admin co-signs);
// - the vault agent: its decision is logged every pass; it trades only with BUNDLE_AGENTS_LIVE=true, an operator key and launches
//   on, and never below an exact quote less AGENT.slippageBps (the program's own floor checks sells only).
// One action per bundle per pass, so a failure on one never blocks the others and nothing is retried in a tight loop.

// A create transaction is co-signed only within 2 minutes of its review (the raise routes), so an opening row older than this never
// becomes a bundle: it frees the repository.
export const BUNDLE_STALE_OPENING_MS = 5 * 60 * 1000
// Route curve fees once at least this much is claimable (each routing costs a transaction fee).
export const ROUTE_MIN_LAMPORTS = 10_000_000n
// Route the router's DAMM v2 position at most this often (its pending fee is not read from one account).
export const POOL_ROUTE_INTERVAL_MS = 6 * 60 * 60 * 1000
// The vault agent (docs/BUNDLE_SIMULATION.md): sell above this multiple of the vault's average cost, buy after this fall from
// the day's high. The program enforces the policy whatever the agent decides.
// slippageBps: each trade's minimum output is the exact Meteora quote less this, so a sandwich can take at most 1% of a trade.
export const AGENT = Object.freeze({ sellAtCost: 1.5, buyAfterFall: 0.15, slippageBps: 100 })
const DAY = 86_400

export function readSecretKey(value) {
  if (!value || !String(value).trim()) return null
  const text = String(value).trim()
  return Keypair.fromSecretKey(text.startsWith('[') ? Uint8Array.from(JSON.parse(text)) : bs58.decode(text))
}

// What the worker needs (each missing piece named, never a value), or null where Bundle was never configured and launches are off.
// launchesOn: new launches (and the agent's trades) follow the switch and the code gate; everything for existing bundles does not,
// so turning launches off never freezes a raise's refunds.
export function bundleJobSettings(env = process.env) {
  const launchesOn = bundleLaunchable(env)
  if (!launchesOn && !String(env.BUNDLE_DBC_CONFIG ?? '').trim()) return null
  const missing = ['BUNDLE_DBC_CONFIG', 'BUNDLE_LOOKUP_TABLE', 'BUNDLE_LAUNCH_SIGNER_SECRET_KEY', 'PLATFORM_CREATOR_SECRET_KEY', 'APP_ORIGIN']
    .filter(name => !String(env[name] ?? '').trim())
  if (missing.length) return { missing }
  return { config: new PublicKey(env.BUNDLE_DBC_CONFIG.trim()), lookupTable: env.BUNDLE_LOOKUP_TABLE.trim(),
    launchSigner: readSecretKey(env.BUNDLE_LAUNCH_SIGNER_SECRET_KEY), creator: readSecretKey(env.PLATFORM_CREATOR_SECRET_KEY),
    operator: readSecretKey(env.BUNDLE_OPERATOR_SECRET_KEY), agentsLive: env.BUNDLE_AGENTS_LIVE === 'true', launchesOn,
    // Each bundle token's metadata URI is built on it: an origin only (a trailing slash or path would break the URI).
    metadataOrigin: new URL(env.APP_ORIGIN.trim()).origin }
}

// The one action a bundle needs this pass. row: the bundles row; chain: the decoded Bundle account or null; market: the markets row
// launched from it, or null; now: unix seconds.
export function bundleAction({ row, chain, market, now, launchesOn = true }) {
  const launchOr = action => launchesOn ? { action } : { action: 'wait', reason: 'Bundle launches are off' }
  if (row.status === 'opening') {
    if (chain) return { action: 'activate' }
    return now * 1000 - new Date(row.createdAt).getTime() > BUNDLE_STALE_OPENING_MS ? { action: 'expire' } : { action: 'wait' }
  }
  if (!chain) return { action: 'wait', reason: 'Bundle account missing' }
  if (row.status === 'raising') {
    if (chain.status === STATUS.FAILED) return { action: 'mark_failed' }
    if (chain.status === STATUS.LAUNCHED) return market?.status === 'confirmed' ? { action: 'mark_launched' } : { action: 'wait' }
    const graceEnd = chain.deadline + chain.launchGraceSecs
    if (chain.raised === chain.target && chain.released === 0n && now <= graceEnd) return launchOr('launch')
    if ((now > chain.deadline && chain.raised < chain.target) || now > graceEnd) return { action: 'fail_raise' }
    return { action: 'wait' }
  }
  if (row.status === 'launching') {
    if (market?.status === 'confirmed' && chain.status === STATUS.LAUNCHED) return { action: 'mark_launched' }
    // Past the grace period the program refuses release, so no launch can land any more: fail the raise so refunds open,
    // whatever state a launch attempt was left in (a repeating refusal, a crash between reserve and send).
    if (chain.status === STATUS.RAISING && chain.released === 0n && now > chain.deadline + chain.launchGraceSecs) return { action: 'fail_raise' }
    if (chain.status === STATUS.RAISING && (!market || market.status === 'failed')) return launchOr('retry_launch')
    if (chain.status === STATUS.FAILED) return { action: 'mark_failed' }
    return { action: 'wait' }
  }
  if (row.status === 'launched') {
    if (chain.vaultSol.equals(PublicKey.default)) return { action: 'open_vault' }
    return { action: 'tend' }
  }
  return { action: 'wait' }
}

// The vault trade's minimum output: the exact Meteora quote at the chain's confirmed clock, less AGENT.slippageBps. Before
// graduation the curve (curve: dbc.state.getPool's answer, curveConfig its DBC config); after it the DAMM v2 pool (damm: its
// state). Both quote helpers check the SDK's minimum against an independent floor and throw when there is no executable output.
export async function vaultTradeMinimumOut({ connection, dbc, amm, curveConfig, curve, damm, buy, amountIn, slippageBps = AGENT.slippageBps }) {
  const direction = buy ? 'buy' : 'sell'
  if (damm) {
    const currentPoint = await readChainPoint(connection, damm.activationType)
    return dammQuote({ amm, poolState: damm, direction, amountIn, currentPoint, slippageBps }).minimumAmountOut
  }
  const config = await readPoolConfig(dbc, curveConfig)
  if (!config) throw Error('Bundle curve config is missing')
  const state = curve.poolState ?? curve
  const currentPoint = quotePoint(await readChainPoint(connection, config.activationType), state.activationPoint)
  const result = dbcSwapQuote({ dbc, virtualPool: curve, config, direction, amountIn: new BN(String(amountIn)), currentPoint, slippageBps })
  return BigInt(result.minimumAmountOut.toString())
}

const bps = (amount, value) => BigInt(amount) * BigInt(value) / BigInt(BPS)
const min = (a, b) => a < b ? a : b

// The vault agent's trade, or null. price and high: lamports per token base unit now and the day's high; balances in base units.
// Every limit the program checks is applied here first, so the agent never sends a trade the program would refuse.
export function vaultAgentDecision({ bundle, price, high, vaultSol, vaultTokens, now }) {
  if (bundle.status !== STATUS.LAUNCHED || bundle.paused || now < bundle.tradingOpensAt || bundle.vaultSol.equals(PublicKey.default)) return null
  const policy = bundle.policy, gap = policy.gapSecs
  const sameDay = Math.floor(now / DAY) === bundle.day
  const bought = sameDay ? bundle.dayBought : 0n, sold = sameDay ? bundle.daySold : 0n
  const cost = bundle.costTokens > 0n ? Number(bundle.costLamports) / Number(bundle.costTokens) : null
  if (cost !== null && vaultTokens > 0n && price >= AGENT.sellAtCost * cost && price >= (policy.floorBps / BPS) * cost * 1.03 &&
    (bundle.lastBuyAt === 0 || now >= bundle.lastBuyAt + gap)) {
    const amount = min(bps(vaultTokens, policy.maxTradeBps), bps(vaultTokens + sold, policy.maxDailySellBps) - sold)
    if (amount > 0n) return { buy: false, amountIn: amount, reason: 'price above the sell target' }
  }
  if (high > 0 && price <= (1 - AGENT.buyAfterFall) * high && vaultSol > 0n && (bundle.lastSellAt === 0 || now >= bundle.lastSellAt + gap)) {
    const amount = min(bps(vaultSol, policy.maxTradeBps), bps(vaultSol + bought, policy.maxDailyBuyBps) - bought)
    if (amount > 0n) return { buy: true, amountIn: amount, reason: 'price fell from the day\'s high' }
  }
  return null
}

const sqrtPrice = value => { const s = Number(value.toString()) / 2 ** 64; return s * s }

export function createBundleJobs({ pool, connection, settings, programId = BUNDLE_VAULT_PROGRAM_ID, now = () => Math.floor(Date.now() / 1000),
  coordinatorFor = null, builderAllocationEnabled = false, log = record => console.log(JSON.stringify({ bundles: record })), dbc: dbcClient = null,
  amm: ammClient = null }) {
  // Every send signs with a confirmed blockhash; a connection at another commitment preflights (and simulates) at that one, and a
  // finalized one refuses a fresh confirmed blockhash, so nothing would ever send.
  if (connection.commitment !== 'confirmed') throw Error('Bundle jobs need a connection at confirmed commitment')
  const program = new PublicKey(programId)
  const { config, lookupTable, launchSigner, creator, operator, agentsLive, metadataOrigin, launchesOn = true } = settings
  const dbc = dbcClient ?? new DynamicBondingCurveClient(connection, 'confirmed'), amm = ammClient ?? new CpAmm(connection)
  const launcher = createBundleLauncher({ connection, config, creator, launchSigner, lookupTable, metadataOrigin, programId: program })
  const coordinator = id => coordinatorFor ? coordinatorFor(id, launcher)
    : createLaunchCoordinator({ pool, launcher, discoveryEnabled: false, builderAllocationEnabled, bundle: { id: String(id) } })
  const lastPoolRoute = new Map()

  // Simulated first (a refusal costs nothing), then sent and confirmed; the launch signer pays.
  async function send(instructions, signers = []) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...instructions)
    tx.feePayer = launchSigner.publicKey
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
    const all = [launchSigner, ...signers.filter(signer => !signer.publicKey.equals(launchSigner.publicKey))]
    tx.sign(...all)
    const simulated = await connection.simulateTransaction(tx)
    if (simulated.value.err) {
      const reason = bundleErrorName((simulated.value.logs ?? []).join('\n')) ?? JSON.stringify(simulated.value.err)
      return { sent: false, reason }
    }
    const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' })
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
    return { sent: true, signature }
  }
  const setStatus = (id, status, extra = {}) => pool.query(`update bundles set status=$2, launch_signature=coalesce($3, launch_signature),
    launch_mint=coalesce($4, launch_mint), launch_error=$5, updated_at=now() where bundle_id=$1`,
  [String(id), status, extra.launchSignature ?? null, extra.launchMint ?? null, extra.launchError ?? null])

  async function launch(row) {
    await setStatus(row.bundleId, 'launching')
    try {
      // The repository is named by its URL for the coordinator; it must still be the bundle's repository (a name can be renamed or
      // reused), or nothing launches.
      const launching = coordinator(row.bundleId), repositoryUrl = `https://github.com/${row.fullName}`
      const repo = await launching.resolveRepository(repositoryUrl)
      if (String(repo.githubRepoId) !== String(row.githubRepoId)) throw Error('The repository behind this bundle changed; launch refused')
      const market = await launching.launch({ repositoryUrl, tokenName: row.tokenName,
        tokenSymbol: row.tokenSymbol, tokenImage: row.tokenImage ?? null, launcherWallet: launchSigner.publicKey.toBase58(),
        signTransaction: launcher.signAsLaunchSigner })
      await setStatus(row.bundleId, 'launched', { launchSignature: market.launchSignature, launchMint: market.mint })
      return { launched: market.mint }
    } catch (error) {
      // An attempt that may have landed stays 'launching': the launch indexer settles it and the next pass reads the market.
      await pool.query('update bundles set launch_error=$2, updated_at=now() where bundle_id=$1', [String(row.bundleId), String(error?.message ?? error).slice(0, 500)])
      return { launchError: String(error?.message ?? error).slice(0, 200) }
    }
  }

  async function tend(row, chain, platform) {
    const accounts = bundleAccounts({ id: chain.id, mint: chain.mint, programId: program })
    const curve = await dbc.state.getPool(chain.pool), state = curve.poolState ?? curve
    // Graduation first: once the curve migrated, the bundle is bound to its DAMM v2 pool before anything else trades or routes.
    if (!chain.graduated && Number(state.isMigrated) === 1) {
      const dammPool = deriveDammV2PoolAddress(chain.dammConfig, chain.mint, NATIVE_MINT)
      const positions = await amm.getPositionsByUser(routerAddress(program))
      const position = positions.find(p => p.positionState.pool.equals(dammPool) && !p.positionState.permanentLockedLiquidity.isZero())
      if (!position) return { graduation: 'router position not found' }
      return { recordGraduation: await send([recordGraduationInstruction({ admin: creator.publicKey, id: chain.id, pool: chain.pool, dammPool,
        position: position.position, positionNftAccount: position.positionNftAccount, programId: program })], [creator]) }
    }
    const routerTokens = createAssociatedTokenAccountIdempotentInstruction(launchSigner.publicKey, tokenAccountOf(routerAddress(program), chain.mint),
      routerAddress(program), chain.mint)
    if (!chain.graduated && BigInt(state.partnerQuoteFee.toString()) >= ROUTE_MIN_LAMPORTS) {
      return { routeCurve: await send([routerTokens, routeCurveFeesInstruction({ id: chain.id, mint: chain.mint, pool: chain.pool,
        config: chain.curveConfig, baseVault: state.baseVault, quoteVault: state.quoteVault, treasury: platform.treasury, programId: program })]) }
    }
    if (chain.graduated && Date.now() - (lastPoolRoute.get(String(chain.id)) ?? 0) >= POOL_ROUTE_INTERVAL_MS) {
      lastPoolRoute.set(String(chain.id), Date.now())
      const damm = await amm.fetchPoolState(chain.dammPool)
      return { routePool: await send([routerTokens, routePoolFeesInstruction({ id: chain.id, mint: chain.mint, dammPool: chain.dammPool,
        position: chain.routerPosition, positionNftAccount: chain.routerPositionNft, tokenAVault: damm.tokenAVault, tokenBVault: damm.tokenBVault,
        treasury: platform.treasury, programId: program })]) }
    }
    return agent(row, chain, curve, accounts)
  }

  async function agent(row, chain, curve, accounts) {
    const curveState = curve.poolState ?? curve
    const [sol, tokens] = await Promise.all([accounts.vaultSol, accounts.vaultTokens].map(account =>
      connection.getTokenAccountBalance(account, 'confirmed').then(result => BigInt(result.value.amount)).catch(() => 0n)))
    const damm = chain.graduated ? await amm.fetchPoolState(chain.dammPool) : null
    const price = sqrtPrice(damm ? damm.sqrtPrice : curveState.sqrtPrice)
    const { rows: [day] } = await pool.query(chain.graduated
      ? `select max(next_sqrt_price::numeric)::text as high from damm_trade_events where pool=$1 and traded_at > now() - interval '24 hours'`
      : `select max(next_sqrt_price::numeric)::text as high from trade_events where pool=$1 and traded_at > now() - interval '24 hours'`,
    [(chain.graduated ? chain.dammPool : chain.pool).toBase58()])
    const high = Math.max(price, day?.high ? sqrtPrice(day.high) : 0)
    const decision = vaultAgentDecision({ bundle: chain, price, high, vaultSol: sol, vaultTokens: tokens, now: now() })
    if (!decision) return { agent: 'hold' }
    // Every trade carries the exact quote's output less AGENT.slippageBps as its minimum; no quote, no trade.
    let minimumOut
    try {
      minimumOut = await vaultTradeMinimumOut({ connection, dbc, amm, curveConfig: chain.curveConfig, curve, damm, buy: decision.buy,
        amountIn: decision.amountIn })
    } catch (error) { return { agent: 'hold', reason: `No quote: ${String(error?.message ?? error).slice(0, 120)}` } }
    const planned = { ...decision, amountIn: decision.amountIn.toString(), minimumOut: minimumOut.toString() }
    if (!agentsLive || !operator || !launchesOn) return { agent: 'dry run', ...planned }
    const swap = chain.graduated
      ? vaultSwapPoolInstruction({ operator: operator.publicKey, id: chain.id, mint: chain.mint, dammPool: chain.dammPool, tokenAVault: damm.tokenAVault,
        tokenBVault: damm.tokenBVault, position: chain.routerPosition, buy: decision.buy, amountIn: decision.amountIn, minimumOut, programId: program })
      : vaultSwapCurveInstruction({ operator: operator.publicKey, id: chain.id, mint: chain.mint, pool: chain.pool, config: chain.curveConfig,
        baseVault: curveState.baseVault, quoteVault: curveState.quoteVault, buy: decision.buy, amountIn: decision.amountIn, minimumOut, programId: program })
    return { agent: decision.reason, minimumOut: planned.minimumOut, trade: await send([swap], [operator]) }
  }

  return {
    async runOnce() {
      const { rows } = await pool.query(`select b.bundle_id::text as "bundleId", b.github_repo_id::text as "githubRepoId", b.status, b.created_at as "createdAt", b.token_name as "tokenName",
        b.token_symbol as "tokenSymbol", b.token_image as "tokenImage", r.full_name as "fullName",
        m.status as "marketStatus", m.mint as "marketMint", m.launch_signature as "marketSignature"
        from bundles b join repositories r on r.github_repo_id = b.github_repo_id left join markets m on m.bundle_id = b.bundle_id
        where b.status in ('opening', 'raising', 'launching', 'launched') order by b.bundle_id`)
      if (!rows.length) return []
      const [platformInfo, ...infos] = await connection.getMultipleAccountsInfo([platformAddress(program), ...rows.map(row => bundleAddress(row.bundleId, program))], 'confirmed')
      const platform = platformInfo?.owner.equals(program) ? decodePlatform(platformInfo.data) : null
      const results = []
      for (const [i, row] of rows.entries()) {
        let chain = null
        try { chain = infos[i]?.owner.equals(program) ? decodeBundle(infos[i].data) : null } catch {}
        const market = row.marketStatus ? { status: row.marketStatus, mint: row.marketMint, launchSignature: row.marketSignature } : null
        const { action, reason } = bundleAction({ row, chain, market, now: now(), launchesOn })
        const result = { bundleId: row.bundleId, action }
        try {
          if (action === 'activate') await setStatus(row.bundleId, 'raising')
          else if (action === 'expire') await setStatus(row.bundleId, 'expired')
          else if (action === 'mark_failed') await setStatus(row.bundleId, 'failed')
          else if (action === 'mark_launched') await setStatus(row.bundleId, 'launched', { launchSignature: market.launchSignature, launchMint: market.mint })
          else if (action === 'fail_raise') Object.assign(result, await send([failRaiseInstruction({ id: row.bundleId, programId: program })]))
          else if (action === 'launch' || action === 'retry_launch') Object.assign(result, await launch(row))
          else if (action === 'open_vault') Object.assign(result, await send([openVaultInstruction({ payer: launchSigner.publicKey, id: row.bundleId, programId: program })]))
          else if (action === 'tend') {
            if (!platform) Object.assign(result, { reason: 'Bundle platform account missing' })
            else Object.assign(result, await tend(row, chain, platform))
          } else if (reason) result.reason = reason
        } catch (error) {
          result.error = String(error?.message ?? error).slice(0, 200)
        }
        results.push(result)
      }
      const shown = results.filter(result => result.action !== 'wait' || result.reason)
      if (shown.length) log(shown)
      return results
    },
  }
}
