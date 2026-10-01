import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { deriveDbcTokenVaultAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DAMM_POOL_AUTHORITY, DBC_POOL_AUTHORITY, FIXED_SUPPLY_BASE_UNITS, classifyAccount, graduationLabel, holderConcentration,
  launcherLines, launcherPosition, maintainerStatus, mintFacts, parseMintAccount, parseTokenAccount, percentLabel, sharePercent } from '../src/trust-signals.mjs'
import { holderSnapshot, loadHolderSnapshot } from '../app/lib/trust-panel.mjs'

const M = 1_000_000n // one whole token in base units
const pct = n => FIXED_SUPPLY_BASE_UNITS * BigInt(Math.round(n * 100)) / 10_000n // n% of supply
const JUP_LOCK = 'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn'

test('percent labels never round a nonzero share to zero', () => {
  assert.equal(sharePercent(pct(2.5), FIXED_SUPPLY_BASE_UNITS), 2.5)
  assert.equal(sharePercent(1n, 0n), null)
  assert.equal(percentLabel(12.345), '12.3%')
  assert.equal(percentLabel(2.5), '2.5%')
  assert.equal(percentLabel(0.004), '<0.01%')
  assert.equal(percentLabel(0), '0%')
  assert.equal(percentLabel(null), '—')
})

test('maintainer is verified by GitHub admin verification or a bound payout wallet', () => {
  assert.deepEqual(maintainerStatus({ wasVerified: true }), { verified: true, payoutWallet: null })
  assert.deepEqual(maintainerStatus({ beneficiaryWallet: 'W' }), { verified: true, payoutWallet: 'W' })
  assert.equal(maintainerStatus({ wasVerified: false, beneficiaryWallet: null }).verified, false)
})

test('launcher who has not sold holds everything they bought', () => {
  const position = launcherPosition({ boughtBaseUnits: pct(3), soldBaseUnits: 0n, launchBuyBaseUnits: pct(2.5) })
  assert.equal(position.state, 'holding')
  assert.equal(position.heldPercent, 3)
  assert.equal(position.launchBuyPercent, 2.5)
  assert.equal(position.soldPercentOfBought, 0)
  assert.deepEqual(launcherLines(position), { title: 'Launcher holds 3% of supply', launch: 'Bought 2.5% at launch', sold: "Hasn't sold" })
})

test('launcher who sold part reports the sold share of what they bought', () => {
  const position = launcherPosition({ boughtBaseUnits: (400n * M).toString(), soldBaseUnits: (100n * M).toString(), launchBuyBaseUnits: '0' })
  assert.equal(position.state, 'sold-some')
  assert.equal(position.soldPercentOfBought, 25)
  assert.equal(position.heldBaseUnits, (300n * M).toString())
  assert.deepEqual(launcherLines(position), { title: 'Launcher holds <0.01% of supply', launch: 'No buy at launch', sold: 'Sold 25% of what they bought' })
})

test('launcher sells beyond indexed buys (transfers in) cap at 100% and never show a negative holding', () => {
  const position = launcherPosition({ boughtBaseUnits: pct(1), soldBaseUnits: pct(2), launchBuyBaseUnits: pct(1) })
  assert.equal(position.state, 'sold-all')
  assert.equal(position.heldPercent, 0)
  assert.equal(position.soldPercentOfBought, 100)
  assert.equal(launcherLines(position).sold, 'Sold all of what they bought')
  const unbought = launcherPosition({ boughtBaseUnits: '0', soldBaseUnits: '5', launchBuyBaseUnits: '0' })
  assert.equal(unbought.state, 'sold-unbought')
  assert.equal(unbought.soldPercentOfBought, null)
  assert.equal(launcherLines(launcherPosition({ boughtBaseUnits: '0', soldBaseUnits: '0', launchBuyBaseUnits: '0' })).title, 'Launcher has no trades on repo.ing')
  assert.equal(launcherPosition({ boughtBaseUnits: 'x', soldBaseUnits: '0', launchBuyBaseUnits: '0' }), null)
  assert.equal(launcherLines(null), null)
})

test('accounts are classified as curve vault, graduated pool, lock escrow or holder', () => {
  const ownerPrograms = new Map([['escrow', JUP_LOCK], ['wallet', '11111111111111111111111111111111']])
  assert.equal(classifyAccount({ address: 'vault', owner: 'x' }, { curveVault: 'vault' }).kind, 'curve')
  assert.equal(classifyAccount({ address: 'a', owner: DBC_POOL_AUTHORITY }).kind, 'curve')
  assert.equal(classifyAccount({ address: 'a', owner: DAMM_POOL_AUTHORITY }).kind, 'pool')
  assert.deepEqual(classifyAccount({ address: 'a', owner: 'escrow' }, { ownerPrograms }), { kind: 'lock', label: 'Jupiter Lock' })
  assert.equal(classifyAccount({ address: 'a', owner: 'wallet' }, { ownerPrograms }).kind, 'holder')
})

test('top-10 share excludes the curve, pool and locks and merges accounts of one owner', () => {
  const accounts = [
    { address: 'vault', owner: DBC_POOL_AUTHORITY, amount: pct(60) },
    { address: 'damm', owner: DAMM_POOL_AUTHORITY, amount: pct(5) },
    { address: 'lock', owner: 'escrow', amount: pct(4) },
    { address: 'a1', owner: 'alice', amount: pct(3) },
    { address: 'a2', owner: 'alice', amount: pct(1) },
    ...Array.from({ length: 11 }, (_, i) => ({ address: `h${i}`, owner: `holder${String(i).padStart(2, '0')}`, amount: pct(2) - BigInt(i) * M })),
    { address: 'empty', owner: 'ghost', amount: 0n },
  ]
  const result = holderConcentration({ supply: FIXED_SUPPLY_BASE_UNITS, accounts, ownerPrograms: new Map([['escrow', JUP_LOCK]]),
    labels: new Map([['alice', { kind: 'team', label: 'repo.ing team' }]]) })
  assert.equal(result.curvePercent, 60)
  assert.equal(result.poolPercent, 5)
  assert.equal(result.lockedPercent, 4)
  assert.equal(result.topCount, 10)
  assert.equal(result.top[0].owner, 'alice')
  assert.equal(result.top[0].percent, 4)
  assert.equal(result.top[0].label, 'repo.ing team')
  assert.ok(!result.top.some(holder => ['escrow', DBC_POOL_AUTHORITY, DAMM_POOL_AUTHORITY, 'ghost', 'holder10'].includes(holder.owner)))
  // alice 4% + nine holders at 2% minus 0..8 whole tokens (36 tokens total).
  const expected = pct(4) + 9n * pct(2) - 36n * M
  assert.equal(result.topPercent, sharePercent(expected, FIXED_SUPPLY_BASE_UNITS))
  assert.equal(holderConcentration({ supply: 0n, accounts }), null)
})

test('graduation label reads the public row stats', () => {
  assert.equal(graduationLabel({ graduated: true }), 'Graduated to the DAMM pool')
  assert.equal(graduationLabel({ graduated: false, bondingPercent: 42.9 }), 'Bonding curve · 42% to graduation')
  assert.equal(graduationLabel({}), 'On the bonding curve')
})

// Raw SPL layouts, as the RPC returns them.
function mintData({ supply = FIXED_SUPPLY_BASE_UNITS, decimals = 6, mintAuthority = null, freezeAuthority = null } = {}) {
  const data = Buffer.alloc(82)
  if (mintAuthority) { data.writeUInt32LE(1, 0); mintAuthority.toBuffer().copy(data, 4) }
  data.writeBigUInt64LE(supply, 36); data[44] = decimals; data[45] = 1
  if (freezeAuthority) { data.writeUInt32LE(1, 46); freezeAuthority.toBuffer().copy(data, 50) }
  return data
}
function tokenData(mint, owner, amount) {
  const data = Buffer.alloc(165)
  mint.toBuffer().copy(data, 0); owner.toBuffer().copy(data, 32); data.writeBigUInt64LE(amount, 64); data[108] = 1
  return data
}

test('mint facts come from the mint account', () => {
  const revoked = mintFacts(parseMintAccount(mintData()))
  assert.deepEqual(revoked, { fixedSupply: true, supplyBaseUnits: FIXED_SUPPLY_BASE_UNITS.toString(), burnedBaseUnits: '0', mintAuthorityRevoked: true, freezeAuthorityRevoked: true })
  const live = mintFacts(parseMintAccount(mintData({ supply: FIXED_SUPPLY_BASE_UNITS - 5n, mintAuthority: Keypair.generate().publicKey })))
  assert.equal(live.mintAuthorityRevoked, false)
  assert.equal(live.fixedSupply, false)
  assert.equal(live.burnedBaseUnits, '5')
  assert.throws(() => parseMintAccount(Buffer.alloc(10)), /mint account/)
  assert.throws(() => parseTokenAccount(Buffer.alloc(10)), /token account/)
})

function fakeChain({ mint, pool, holders, lockEscrow }) {
  const vault = deriveDbcTokenVaultAddress(pool, mint)
  const rows = [[vault, new PublicKey(DBC_POOL_AUTHORITY), pct(70)], [Keypair.generate().publicKey, lockEscrow, pct(5)],
    ...holders.map(([owner, amount]) => [Keypair.generate().publicKey, owner, amount])]
  const accounts = new Map([[mint.toBase58(), { data: mintData(), owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }],
    ...rows.map(([address, owner, amount]) => [address.toBase58(), { data: tokenData(mint, owner, amount) }])])
  const programs = new Map([[lockEscrow.toBase58(), new PublicKey(JUP_LOCK)]])
  const calls = []
  return {
    calls,
    async getTokenLargestAccounts(key) {
      calls.push('largest')
      assert.ok(key.equals(mint))
      return { value: rows.map(([address, , amount]) => ({ address, amount: amount.toString() })) }
    },
    async getMultipleAccountsInfo(keys, config) {
      calls.push(config?.dataSlice ? 'owners' : 'accounts')
      if (config?.dataSlice) return keys.map(key => ({ owner: programs.get(key.toBase58()) ?? new PublicKey('11111111111111111111111111111111'), data: Buffer.alloc(0) }))
      return keys.map(key => accounts.get(key.toBase58()) ?? null)
    },
  }
}

test('holder snapshot batches three RPC reads and resolves token accounts to owners', async () => {
  const mint = Keypair.generate().publicKey, pool = Keypair.generate().publicKey
  const alice = Keypair.generate().publicKey, bob = Keypair.generate().publicKey
  const connection = fakeChain({ mint, pool, lockEscrow: Keypair.generate().publicKey, holders: [[alice, pct(6)], [alice, pct(1)], [bob, pct(3)]] })
  const snapshot = await loadHolderSnapshot(connection, mint.toBase58(), pool.toBase58())
  assert.deepEqual(connection.calls, ['largest', 'accounts', 'owners'])
  assert.equal(snapshot.mint.fixedSupply, true)
  assert.equal(snapshot.mint.mintAuthorityRevoked, true)
  assert.equal(snapshot.holders.curvePercent, 70)
  assert.equal(snapshot.holders.lockedPercent, 5)
  assert.equal(snapshot.holders.topCount, 2)
  assert.equal(snapshot.holders.topPercent, 10)
  assert.deepEqual(snapshot.holders.top.map(holder => [holder.owner, holder.percent]), [[alice.toBase58(), 7], [bob.toBase58(), 3]])
})

test('holder snapshot is cached per mint, deduplicated in flight, and never throws', async () => {
  const mint = Keypair.generate().publicKey, pool = Keypair.generate().publicKey
  const connection = fakeChain({ mint, pool, lockEscrow: Keypair.generate().publicKey, holders: [[Keypair.generate().publicKey, pct(1)]] })
  let clock = 1_000
  const market = { mint: mint.toBase58(), pool: pool.toBase58(), beneficiaryWallet: null }
  const [first, second] = await Promise.all([holderSnapshot(market, { connection, now: () => clock }), holderSnapshot(market, { connection, now: () => clock })])
  assert.equal(first, second)
  assert.equal(connection.calls.filter(call => call === 'largest').length, 1)
  clock += 299_000
  await holderSnapshot(market, { connection, now: () => clock })
  assert.equal(connection.calls.filter(call => call === 'largest').length, 1)
  clock += 2_000
  await holderSnapshot(market, { connection, now: () => clock })
  assert.equal(connection.calls.filter(call => call === 'largest').length, 2)

  const failing = { mint: Keypair.generate().publicKey.toBase58(), pool: pool.toBase58() }
  const broken = { getTokenLargestAccounts: async () => { throw new Error('429 Too Many Requests') } }
  const originalError = console.error
  console.error = () => {}
  try { assert.equal(await holderSnapshot(failing, { connection: broken, now: () => clock }), null) }
  finally { console.error = originalError }
})
