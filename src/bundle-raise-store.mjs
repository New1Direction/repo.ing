// The bundles table (migration 0060) as the raise flow uses it. This flow inserts a row as 'opening' when it prepares a bundle's
// create transaction and moves it to 'raising' once that transaction landed; the worker moves it on from there (launching,
// launched, failed) and expires an 'opening' row that never landed. Amounts are lamports as text.

export const LIVE_BUNDLE_STATUSES = Object.freeze(['opening', 'raising', 'launching', 'launched'])

// ageMs: the row's age on the database's clock, as for launch reviews (src/launch-sessions.mjs), so replica clock skew cannot
// stretch or cut an opening's review.
const COLUMNS = `b.bundle_id::text as "bundleId", b.github_repo_id::text as "githubRepoId", b.address, b.creator_wallet as "creatorWallet",
  b.token_name as "tokenName", b.token_symbol as "tokenSymbol", b.target_lamports::text as "targetLamports",
  b.min_deposit_lamports::text as "minDepositLamports", b.deadline, b.status, b.create_signature as "createSignature",
  b.launch_mint as "launchMint", b.created_at as "createdAt",
  (extract(epoch from (now() - b.created_at)) * 1000)::bigint::text as "ageMs",
  r.full_name as "fullName", r.owner, r.name, r.avatar_url as "avatarUrl", r.description,
  (select m.mint from markets m where m.bundle_id = b.bundle_id and m.status = 'confirmed' and m.indexed_at is not null
    and m.launch_finality = 'finalized') as "marketMint"`

// What stops a repository from opening a bundle: any market row that did not fail (a market, or a launch in progress), and a
// live bundle (its status, so the page can say why, and its id, so it can link to it).
export async function repositoryBlockers(pool, repoId) {
  const { rows: [row] } = await pool.query(`select
      exists(select 1 from markets where github_repo_id = $1 and status <> 'failed') as "hasMarket",
      b.status as "liveBundle", b.bundle_id::text as "liveBundleId"
    from (select 1) one left join lateral (select status, bundle_id from bundles where github_repo_id = $1 and status = any($2::text[])
      limit 1) b on true`, [String(repoId), LIVE_BUNDLE_STATUSES])
  return { hasMarket: row?.hasMarket === true, liveBundle: row?.liveBundle ?? null, liveBundleId: row?.liveBundleId ?? null }
}

// Whether the site ever opened a bundle: until it has, /wallet makes no Backer read at all.
export async function anyBundles(pool) {
  const { rows: [row] } = await pool.query('select exists(select 1 from bundles) as "any"')
  return row?.any === true
}

// The next bundle id: the only source of ids, since the program's Bundle PDA is seeded with it and only repo.ing co-signs.
export async function nextBundleId(pool) {
  const { rows: [row] } = await pool.query(`select nextval('bundle_id_seq')::text as id`)
  return BigInt(row.id)
}

// The prepared bundle, as 'opening'. False when the repository got a live bundle meanwhile (bundles_one_live_per_repo).
export async function insertOpeningBundle(pool, { bundleId, githubRepoId, address, creatorWallet, tokenName, tokenSymbol, tokenImage,
  targetLamports, minDepositLamports, deadline }) {
  try {
    await pool.query(`insert into bundles(bundle_id, github_repo_id, address, creator_wallet, token_name, token_symbol, token_image,
        target_lamports, min_deposit_lamports, deadline, status)
      values($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), 'opening')`,
    [String(bundleId), String(githubRepoId), address, creatorWallet, tokenName, tokenSymbol, tokenImage, String(targetLamports),
      String(minDepositLamports), deadline])
    return true
  } catch (error) {
    if (error?.code === '23505' && /bundles_one_live_per_repo/.test(error.constraint ?? error.message ?? '')) return false
    throw error
  }
}

// One bundle with its repository and, once launched, its live market's mint; null when the site never opened it.
export async function loadBundle(pool, id) {
  const { rows: [row] } = await pool.query(`select ${COLUMNS} from bundles b join repositories r on r.github_repo_id = b.github_repo_id
    where b.bundle_id = $1`, [String(id)])
  return row ?? null
}

// The token image chosen when the bundle was opened (a data URL), read only where it is shown.
export async function bundleTokenImage(pool, id) {
  const { rows: [row] } = await pool.query('select token_image as "tokenImage" from bundles where bundle_id = $1', [String(id)])
  return row?.tokenImage ?? null
}

// Several bundles by id (the wallet overview's backed bundles), keyed by id.
export async function loadBundles(pool, ids) {
  if (!ids.length) return new Map()
  const { rows } = await pool.query(`select ${COLUMNS} from bundles b join repositories r on r.github_repo_id = b.github_repo_id
    where b.bundle_id = any($1::bigint[])`, [ids.map(String)])
  return new Map(rows.map(row => [row.bundleId, row]))
}

// The create transaction landed: 'opening' → 'raising', once. signature: the create transaction's, or null when it is not known
// (the account was found on chain after an earlier attempt). Returns whether this call moved it.
export async function markRaising(pool, id, signature) {
  const { rowCount } = await pool.query(`update bundles set status = 'raising', create_signature = coalesce($2, create_signature), updated_at = now()
    where bundle_id = $1 and status = 'opening'`, [String(id), signature])
  return rowCount > 0
}
