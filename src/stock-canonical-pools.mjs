import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token'
import { CP_AMM_PROGRAM_ID, CpAmm, derivePoolAuthority, derivePositionNftAccount, deriveTokenVaultAddress } from '@meteora-ag/cp-amm-sdk'
import { BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'
import { STOCK_FEE_CUSTODY } from './stock-collections.mjs'
import { stockAsset } from './stock-accumulator.mjs'

// The canonical REPOING/<stock> DAMM v2 pool of each stock (docs/STOCK_QUOTES.md, "Accumulator and settlement"). The owner
// creates and seeds it himself from the accumulated fees; this module only checks his pool against the chain and records it
// in stock_canonical_pools (migration 0054, one active pool per stock). It builds, signs and sends nothing and loads no key.

export const REPOING_MINT = OFFICIAL_TOKEN.mint
// The protocol wallets the owner creates, holds and settles canonical pools from: the stock fee custody (the partner wallet,
// where collected stock fees land), the platform-revenue custody and the team wallet (which added the REPOING/SOL protocol
// liquidity, app/lib/liquidity-receipts.mjs). Constants, never arguments: a pool or position held anywhere else is refused.
export const STOCK_POOL_OWNERS = Object.freeze([...new Set([STOCK_FEE_CUSTODY, BUYBACK_WALLETS.custody, OFFICIAL_TOKEN.teamWallet])])
const sha256 = data => createHash('sha256').update(data).digest('hex')
const text = value => value.toString()
const lockKey = assetId => `stock-canonical-pool:${assetId}`

// A position of the pool held by an owner wallet: its liquidity split and whether every unit of it is permanently locked.
export function positionFacts(address, state, nft, nftAccount) {
  const unlocked = BigInt(state.unlockedLiquidity.toString()), vested = BigInt(state.vestedLiquidity.toString())
  const permanent = BigInt(state.permanentLockedLiquidity.toString())
  return { address, nftMint: state.nftMint.toBase58(), nftAccount, owner: nft.owner.toBase58(),
    liquidity: { unlocked: text(unlocked), vested: text(vested), permanent: text(permanent), total: text(unlocked + vested + permanent) },
    fullyLocked: unlocked === 0n && vested === 0n && permanent > 0n }
}

// Reads one position account and its NFT, and checks the position belongs to `pool` and its NFT to an owner wallet.
export async function readOwnedPosition({ connection, coder, pool, position, owners, commitment = 'finalized' }) {
  const positionKey = new PublicKey(position)
  const info = await connection.getAccountInfo(positionKey, commitment)
  if (!info?.owner.equals(CP_AMM_PROGRAM_ID)) throw Error(`Position ${position} is not a DAMM v2 position`)
  const state = coder.decode('position', info.data)
  if (state.pool.toBase58() !== pool) throw Error(`Position ${position} belongs to another pool`)
  const nftAccount = derivePositionNftAccount(state.nftMint)
  const nftInfo = await connection.getAccountInfo(nftAccount, commitment)
  if (!nftInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) throw Error(`Position ${position} NFT account is missing`)
  const nft = unpackAccount(nftAccount, nftInfo, TOKEN_2022_PROGRAM_ID)
  if (!nft.mint.equals(state.nftMint) || nft.amount !== 1n || nft.delegate) throw Error(`Position ${position} NFT is not held whole and undelegated`)
  if (!owners.includes(nft.owner.toBase58())) throw Error(`Position ${position} is held by ${nft.owner.toBase58()}, not an owner wallet`)
  return { ...positionFacts(positionKey.toBase58(), state, nft, nftAccount.toBase58()), dataSha256: sha256(info.data) }
}

// Checks an owner-created pool against the chain at finalized commitment: a DAMM v2 pool of exactly REPOING (SPL Token) and the
// stock's pinned mint (Token-2022), created by an owner wallet, enabled, with both vaults the program's own; and the owner's
// position in it (given, or the one position an owner wallet holds there). Returns what stock_canonical_pools records.
export async function verifyCanonicalPool({ connection, assetId, pool, position = null, owners = STOCK_POOL_OWNERS, repoingMint = REPOING_MINT }) {
  const asset = stockAsset(assetId)
  const poolKey = new PublicKey(pool), repoing = new PublicKey(repoingMint), stock = new PublicKey(asset.mint)
  const amm = new CpAmm(connection), coder = amm._program.coder.accounts
  const read = await connection.getMultipleAccountsInfoAndContext([poolKey, repoing, stock], 'finalized')
  const [poolInfo, repoingInfo, stockInfo] = read.value
  if (!poolInfo?.owner.equals(CP_AMM_PROGRAM_ID)) throw Error(`${pool} is not a DAMM v2 pool`)
  if (!repoingInfo?.owner.equals(TOKEN_PROGRAM_ID)) throw Error('REPOING mint is not an SPL Token mint')
  if (!stockInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) throw Error(`${asset.symbol} mint is not a Token-2022 mint`)
  const state = coder.decode('pool', poolInfo.data)
  const sides = state.tokenAMint.equals(repoing) && state.tokenBMint.equals(stock) ? { repoing: 'A', stock: 'B' }
    : state.tokenAMint.equals(stock) && state.tokenBMint.equals(repoing) ? { repoing: 'B', stock: 'A' } : null
  if (!sides) throw Error(`The pool trades ${state.tokenAMint.toBase58()} / ${state.tokenBMint.toBase58()}, not exactly REPOING and ${asset.symbol}`)
  const flag = side => side === 'A' ? state.tokenAFlag : state.tokenBFlag
  if (flag(sides.repoing) !== 0 || flag(sides.stock) !== 1) throw Error('The pool does not hold REPOING through SPL Token and the stock through Token-2022')
  if (state.poolStatus !== 0) throw Error('The pool is disabled')
  const creator = state.creator.toBase58()
  if (!owners.includes(creator)) throw Error(`The pool was created by ${creator}, not an owner wallet`)
  const vaults = { A: state.tokenAVault, B: state.tokenBVault }
  if (!vaults.A.equals(deriveTokenVaultAddress(state.tokenAMint, poolKey)) || !vaults.B.equals(deriveTokenVaultAddress(state.tokenBMint, poolKey)))
    throw Error("The pool's vaults are not the program's own")
  const vaultInfos = await connection.getMultipleAccountsInfo([vaults.A, vaults.B], 'finalized')
  const authority = derivePoolAuthority()
  for (const [i, side] of ['A', 'B'].entries()) {
    const program = side === sides.repoing ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
    const mint = side === sides.repoing ? repoing : stock
    if (!vaultInfos[i]?.owner.equals(program)) throw Error(`Vault ${side} is not held by its token program`)
    const vault = unpackAccount(vaults[side], vaultInfos[i], program)
    if (!vault.mint.equals(mint) || !vault.owner.equals(authority)) throw Error(`Vault ${side} is not the pool's ${side === sides.repoing ? 'REPOING' : asset.symbol} vault`)
  }
  let owned
  if (position) owned = await readOwnedPosition({ connection, coder, pool: poolKey.toBase58(), position, owners })
  else {
    const found = []
    for (const owner of owners) for (const item of await amm.getUserPositionByPool(poolKey, new PublicKey(owner))) found.push(item.position.toBase58())
    if (found.length !== 1) throw Error(found.length ? `Owner wallets hold ${found.length} positions in this pool (${found.join(', ')}); name the canonical one` : 'No owner wallet holds a position in this pool')
    owned = await readOwnedPosition({ connection, coder, pool: poolKey.toBase58(), position: found[0], owners })
  }
  if (BigInt(owned.liquidity.total) <= 0n) throw Error('The owner position holds no liquidity')
  const reserve = side => text(side === 'A' ? state.tokenAAmount : state.tokenBAmount)
  const evidence = { slot: read.context.slot, programs: { damm: CP_AMM_PROGRAM_ID.toBase58(), repoingToken: TOKEN_PROGRAM_ID.toBase58(),
      stockToken: TOKEN_2022_PROGRAM_ID.toBase58() },
    pool: { address: poolKey.toBase58(), dataSha256: sha256(poolInfo.data), creator, sides, tokenAMint: state.tokenAMint.toBase58(),
      tokenBMint: state.tokenBMint.toBase58(), tokenAVault: vaults.A.toBase58(), tokenBVault: vaults.B.toBase58(),
      collectFeeMode: state.collectFeeMode, activationType: state.activationType, liquidity: text(state.liquidity),
      sqrtPrice: text(state.sqrtPrice), sqrtMinPrice: text(state.sqrtMinPrice), sqrtMaxPrice: text(state.sqrtMaxPrice),
      reserves: { repoing: reserve(sides.repoing), stock: reserve(sides.stock) } },
    position: owned, owners: [...owners] }
  return { assetId: asset.assetId, symbol: asset.symbol, quoteMint: asset.mint, pool: poolKey.toBase58(), repoingMint: repoing.toBase58(),
    position: owned.address, owner: owned.owner, fullyLocked: owned.fullyLocked, evidence }
}

// The active canonical pool of a stock, or null.
export async function activeCanonicalPool(db, assetId) {
  const { rows: [row] } = await db.query(`select id::text, asset_id as "assetId", quote_mint as "quoteMint", pool, repoing_mint as "repoingMint",
    position, evidence, registered_at as "registeredAt" from stock_canonical_pools where asset_id=$1 and active`, [assetId])
  return row ?? null
}

// Records a verified pool as its stock's active canonical pool. Registering the same pool again changes nothing; another pool
// while one is active is refused: retiring a canonical pool is a deliberate owner decision, not something a script does.
export async function registerCanonicalPool(pool, verified) {
  const asset = stockAsset(verified.assetId)
  if (verified.quoteMint !== asset.mint) throw Error('Verified pool names another mint than the registry')
  const db = await pool.connect()
  try {
    await db.query('begin')
    try {
      await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(asset.assetId)])
      const active = await activeCanonicalPool(db, asset.assetId)
      if (active && active.pool !== verified.pool) throw Error(`${asset.symbol} already has an active canonical pool, ${active.pool}; retiring it is an owner decision`)
      if (active) { await db.query('rollback'); return { status: 'already-registered', row: active } }
      const { rows: [row] } = await db.query(`insert into stock_canonical_pools (asset_id, quote_mint, pool, repoing_mint, position, evidence, active)
        values ($1,$2,$3,$4,$5,$6,true) returning id::text, asset_id as "assetId", quote_mint as "quoteMint", pool, repoing_mint as "repoingMint",
        position, evidence, registered_at as "registeredAt"`, [asset.assetId, asset.mint, verified.pool, verified.repoingMint, verified.position,
        JSON.stringify(verified.evidence)])
      await db.query('commit')
      return { status: 'registered', row }
    } catch (error) { await db.query('rollback').catch(() => {}); throw error }
  } finally { db.release() }
}

// Plain-English lines for a verification.
export function describeCanonicalPool(verified) {
  const e = verified.evidence
  return [`REPOING/${verified.symbol} pool ${verified.pool} checks out on chain (slot ${e.slot}):`,
    `  a DAMM v2 pool (${e.programs.damm}) of exactly REPOING ${verified.repoingMint} (token ${e.pool.sides.repoing}, SPL Token) and ` +
    `${verified.symbol} ${verified.quoteMint} (token ${e.pool.sides.stock}, Token-2022), created by owner wallet ${e.pool.creator}, enabled, ` +
    `with the program's own vaults; it holds ${e.pool.reserves.repoing} raw REPOING and ${e.pool.reserves.stock} raw ${verified.symbol}.`,
    `  owner position ${verified.position} is held by ${verified.owner}: liquidity ${e.position.liquidity.total}, of which ` +
    `${e.position.liquidity.permanent} permanently locked${verified.fullyLocked ? ' (all of it)' : `; ${e.position.liquidity.unlocked} unlocked and ${e.position.liquidity.vested} vesting are NOT permanent yet`}.`]
}
