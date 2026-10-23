import { PublicKey } from '@solana/web3.js'

// Public, explicitly approved bindings for accounting only. Custody is not beneficiary identity,
// and accepting a binding here never authorizes a claim, transfer or transaction signer.
export function createCustodyRecovery(manifest = null) {
  const fail = () => { throw Error('Invalid custody binding; review required') }
  const common = ['repoId', 'curve', 'config', 'mint', 'previousOwner', 'owner']
  const positionFields = [...common, 'role', 'pool', 'migration', 'position', 'nftAccount', 'nftMint']
  const copy = (rows, fields, identity) => {
    if (!Array.isArray(rows)) fail()
    const entries = new Map()
    for (const row of rows) {
      if (!row || Object.keys(row).length !== fields.length || fields.some(f => typeof row[f] !== 'string' || !row[f])) fail()
      if (!/^[1-9][0-9]*$/.test(row.repoId) || (fields.includes('role') && !['creator', 'partner'].includes(row.role))) fail()
      for (const field of fields.filter(f => !['repoId', 'role', 'migration'].includes(f))) {
        try { if (new PublicKey(row[field]).toBase58() !== row[field]) fail() } catch { fail() }
      }
      if (entries.has(row[identity]) || row.owner === row.previousOwner) fail()
      entries.set(row[identity], Object.freeze({ ...row }))
    }
    return entries
  }
  if (manifest !== null && (!manifest || manifest.version !== 1 ||
      Object.keys(manifest).sort().join(',') !== 'poolCreators,positions,version')) fail()
  const creators = copy(manifest?.poolCreators ?? (manifest === null ? [] : undefined), common, 'curve')
  const positions = copy(manifest?.positions ?? (manifest === null ? [] : undefined), positionFields, 'nftAccount')
  const context = (market, config, previousOwner) => ({ repoId: String(market.githubRepoId ?? market.repoId),
    curve: market.pool, config: config.toBase58(), mint: market.mint, previousOwner })
  const resolve = (binding, expected) => {
    if (!binding) return expected.previousOwner
    if (Object.entries(expected).some(([field, value]) => binding[field] !== value)) fail()
    return binding.owner
  }
  return Object.freeze({
    creator: (market, config) => resolve(creators.get(market.pool), context(market, config, market.creatorWallet)),
    position: (role, market, config, pool, proof, previousOwner) => {
      const position = role === 'creator' ? proof : proof.partner
      return resolve(positions.get(position.nftAccount.toBase58()), { ...context(market, config, previousOwner), role,
        pool: pool.toBase58(), migration: proof.signature, position: position.position.toBase58(),
        nftAccount: position.nftAccount.toBase58(), nftMint: position.nftMint.toBase58() })
    },
  })
}
