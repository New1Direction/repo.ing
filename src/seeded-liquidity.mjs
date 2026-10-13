// Builder- and platform-seeded liquidity, disclosed per market (docs/LAUNCH_TRANSPARENCY.md#seeded-liquidity-disclosure): every
// position that entered a market at launch or from repo.ing, with the wallet's label, the amounts from finalized evidence, and
// its lock state in plain words. Lock states:
//   unlocked                 in a wallet that can sell or move it at any time
//   program-controlled       held by a program account with no withdraw instruction; traded only within on-chain limits
//   claimable-after-graduation  reserved by the config, claimable by the verified builder only after graduation
//   permanently-locked       DAMM v2 liquidity locked forever on chain (fees stay claimable)
//   withdrawable-by-platform an LP position repo.ing controls and can withdraw
export const LOCK_STATES = Object.freeze({
  unlocked: 'Unlocked: the wallet can sell or move these tokens at any time.',
  'program-controlled': 'Held by the Group launch program: it has no withdraw instruction, and operators can only trade it within on-chain limits. The program\'s upgrade authority could change the program.',
  'claimable-after-graduation': 'Reserved by the market config; the verified builder can claim it only after graduation.',
  'permanently-locked': 'Permanently locked on chain; only trading fees can be claimed.',
  'withdrawable-by-platform': 'Not locked: repo.ing controls this LP position and can withdraw it.',
})

export const BUILDER_ALLOCATION_BASE_UNITS = 10_000_000_000_000n
const SUPPLY = 1_000_000_000_000_000n
const percentOfSupply = tokens => Number(BigInt(tokens) * 1_000_000n / SUPPLY) / 10_000

// facts: { market, launchTrades: [{ trader, lamports, tokens, direction }], launcherPosition, labels, proof, allocationClaim,
// liquidityIntents: [...], manualLiquidity: [...] }
export function seededLiquidity({ market, launchTrades = [], launcherPosition = null, labels = new Map(), proof = null, allocationClaim = null,
  liquidityIntents = [], manualLiquidity = [] }) {
  const rows = []
  const labelOf = wallet => labels.get(wallet)?.label ?? null
  const buys = launchTrades.filter(trade => trade.direction === 'buy')
  const spent = buys.reduce((sum, trade) => sum + BigInt(trade.lamports), 0n), tokens = buys.reduce((sum, trade) => sum + BigInt(trade.tokens), 0n)
  if (market.bundleId !== null && market.bundleId !== undefined) {
    rows.push({ kind: 'group-vault', label: 'Group launch vault', wallet: market.bundleVault ?? null, solLamports: spent.toString(),
      tokenBaseUnits: tokens.toString(), percentOfSupply: percentOfSupply(tokens), lock: 'program-controlled', lockText: LOCK_STATES['program-controlled'],
      evidence: market.launchSignature ?? null })
  } else if (tokens > 0n) {
    rows.push({ kind: 'launch-buy', label: labelOf(market.launcherWallet) ?? 'Launcher', wallet: market.launcherWallet, solLamports: spent.toString(),
      tokenBaseUnits: tokens.toString(), percentOfSupply: percentOfSupply(tokens), lock: 'unlocked', lockText: LOCK_STATES.unlocked,
      evidence: market.launchSignature ?? null,
      currentIndexedPercent: launcherPosition?.heldPercent ?? null, launcherState: launcherPosition?.state ?? null })
  } else {
    rows.push({ kind: 'launch-buy', label: labelOf(market.launcherWallet) ?? 'Launcher', wallet: market.launcherWallet, solLamports: '0', tokenBaseUnits: '0',
      percentOfSupply: 0, lock: null, lockText: 'No initial buy: the launch transaction bought nothing.', evidence: market.launchSignature ?? null })
  }
  if (market.builderAllocationVersion === 1) {
    rows.push({ kind: 'builder-allocation', label: 'Builder allocation (1%)', wallet: allocationClaim?.wallet ?? null,
      solLamports: '0', tokenBaseUnits: BUILDER_ALLOCATION_BASE_UNITS.toString(), percentOfSupply: percentOfSupply(BUILDER_ALLOCATION_BASE_UNITS),
      lock: allocationClaim?.status === 'settled' ? 'unlocked' : 'claimable-after-graduation',
      lockText: allocationClaim?.status === 'settled' ? `Claimed by the verified builder to ${allocationClaim.wallet}. ${LOCK_STATES.unlocked}` : LOCK_STATES['claimable-after-graduation'],
      evidence: allocationClaim?.signature ?? null })
  }
  if (proof) {
    rows.push({ kind: 'migrated-lp', label: 'Migrated liquidity (creator and partner positions)', wallet: null, positions: [proof.creatorPosition, proof.partnerPosition],
      solLamports: null, tokenBaseUnits: null, percentOfSupply: null, lock: 'permanently-locked', lockText: LOCK_STATES['permanently-locked'], evidence: proof.signature })
  }
  for (const intent of liquidityIntents) {
    rows.push({ kind: 'protocol-liquidity', label: 'repo.ing protocol liquidity', wallet: intent.lpOwner, position: intent.position ?? null,
      solLamports: String(intent.sourceAmount), tokenBaseUnits: null, percentOfSupply: null,
      lock: intent.lockMode === 'permanent' ? 'permanently-locked' : 'withdrawable-by-platform',
      lockText: intent.lockMode === 'permanent' ? LOCK_STATES['permanently-locked'] : LOCK_STATES['withdrawable-by-platform'], evidence: intent.signature ?? null })
  }
  for (const receipt of manualLiquidity) {
    rows.push({ kind: 'team-liquidity', label: labelOf(receipt.wallet) ?? 'repo.ing team', wallet: receipt.wallet, position: receipt.positionNft ?? null,
      solLamports: receipt.solLamports, tokenBaseUnits: receipt.tokenBaseUnits, percentOfSupply: percentOfSupply(receipt.tokenBaseUnits),
      lock: receipt.locked ? 'permanently-locked' : 'withdrawable-by-platform',
      lockText: receipt.locked ? LOCK_STATES['permanently-locked'] : LOCK_STATES['withdrawable-by-platform'], evidence: receipt.signature })
  }
  return rows
}

// Database facts for seededLiquidity (no RPC). A database before the relevant migrations has none of the optional rows.
export async function readSeedFacts(db, market) {
  const optional = (sql, params) => db.query(sql, params).then(result => result.rows, error => (['42P01', '42703'].includes(error?.code) ? [] : Promise.reject(error)))
  const [launchTrades, proofs, claims, intents] = await Promise.all([
    market.launchSignature ? optional(`select trader, direction, (case when direction = 'buy' then input_base_units else output_base_units end) as lamports,
      (case when direction = 'buy' then output_base_units else input_base_units end) as tokens from trade_events where signature = $1 and pool = $2`,
    [market.launchSignature, market.pool]) : [],
    optional(`select creator_position as "creatorPosition", partner_position as "partnerPosition", signature from graduated_migration_proofs where github_repo_id = $1`, [String(market.githubRepoId)]),
    optional(`select wallet, status, signature from builder_allocation_claims where github_repo_id = $1 order by id desc limit 1`, [String(market.githubRepoId)]),
    optional(`select lp_owner as "lpOwner", position, source_amount::text as "sourceAmount", lock_mode as "lockMode", signature from liquidity_intents
      where github_repo_id = $1 and status = 'settled' order by id`, [String(market.githubRepoId)]),
  ])
  return { launchTrades, proof: proofs[0] ?? null, allocationClaim: claims[0] ?? null, liquidityIntents: intents }
}
