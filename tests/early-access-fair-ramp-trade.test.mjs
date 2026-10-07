import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import { AccountLayout, MintLayout, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK, dbcBaseVault, earlyAccessAddresses } from '../src/early-access-hook.mjs'
import { assertWithinWalletLimit, fairRampLimit } from '../src/early-access-trade.mjs'

// The fair ramp's pre-check on the site's curve trader (docs/EARLY_ACCESS.md): a buy that would take a wallet past its limit is
// refused before anything is built, with the room left, exactly where the hook would refuse it. Accounts in their real layouts.
const SUPPLY = 1_000_000_000_000_000n, VAULT_END = 369_596_929_504_076n
const mint = Keypair.generate().publicKey, pool = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey
const market = rules => ({ mint: mint.toBase58(), pool: pool.toBase58(), earlyAccessEnd: new Date(), hookRules: rules })
const vault = dbcBaseVault(mint, pool), own = getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_2022_PROGRAM_ID)

function mintConfig({ rules = 3, starsAtLaunch = 0, starsNow = 0, star = rules & 4 }) {
  const data = Buffer.alloc(175)
  createHash('sha256').update('account:MintConfig').digest().copy(data, 0, 0, 8)
  mint.toBuffer().copy(data, 8)
  data[48] = rules
  data.writeUInt16LE(200, 131); data.writeUInt16LE(1000, 133); data.writeBigUInt64LE(SUPPLY, 135); data.writeBigUInt64LE(VAULT_END, 143)
  data.writeUInt32LE(starsAtLaunch, 151); data.writeUInt32LE(star ? 100 : 0, 155); data.writeUInt16LE(star ? 50 : 0, 159); data.writeUInt16LE(star ? 500 : 0, 161)
  data.writeUInt32LE(starsNow, 163)
  return { owner: HOOK, data, lamports: 1, executable: false }
}
const mintAccount = (supply = SUPPLY) => { const data = Buffer.alloc(MintLayout.span)
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals: 6, isInitialized: true, freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default }, data)
  return { owner: TOKEN_2022_PROGRAM_ID, data, lamports: 1, executable: false } }
const tokenAccount = (owner, amount) => { const data = Buffer.alloc(165)
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data)
  return { owner: TOKEN_2022_PROGRAM_ID, data, lamports: 1, executable: false } }

function connection({ config = mintConfig({}), vaultAmount = SUPPLY, held = null, supply = SUPPLY } = {}) {
  const reads = []
  return { reads, getMultipleAccountsInfo: async keys => { reads.push(keys.map(String))
    return [config, mintAccount(supply), tokenAccount(Keypair.generate().publicKey, vaultAmount), held === null ? null : tokenAccount(wallet, held)] } }
}
const check = (conn, rules, outputAmount) => assertWithinWalletLimit({ connection: conn, market: market(rules), wallet: wallet.toBase58(), outputAmount })

test('at the start a wallet may get 2% of the supply; a token more is refused with the room left', async () => {
  const conn = connection()
  await check(conn, 3, SUPPLY * 2n / 100n)
  assert.deepEqual(conn.reads[0], [earlyAccessAddresses(mint).config.toBase58(), mint.toBase58(), vault.toBase58(), own.toBase58()])
  await assert.rejects(check(conn, 3, SUPPLY * 2n / 100n + 1n), { message: fairRampLimit(200, SUPPLY * 2n / 100n) })
  // What the wallet holds counts, and is left out of its own progress (the hook's rule).
  const holder = connection({ held: SUPPLY / 100n })
  await check(holder, 3, SUPPLY / 100n)
  await assert.rejects(check(holder, 3, SUPPLY / 100n + 1n), /at most 2% of the supply right now.*about 10,000,000 more tokens/)
})

test('the limit rises as the curve sells, star reports add to it, and past the span there is none', async () => {
  const halfway = SUPPLY - (SUPPLY - VAULT_END) / 2n
  await check(connection({ vaultAmount: halfway }), 3, SUPPLY * 6n / 100n)
  await assert.rejects(check(connection({ vaultAmount: halfway }), 3, SUPPLY * 6n / 100n + 1n), /at most 6% of the supply/)
  const stars = connection({ config: mintConfig({ rules: 7, starsAtLaunch: 10, starsNow: 310 }) })
  await check(stars, 7, SUPPLY * 35n / 1000n)
  await assert.rejects(check(stars, 7, SUPPLY * 35n / 1000n + 1n), /at most 3.5% of the supply/)
  await check(connection({ vaultAmount: VAULT_END }), 3, SUPPLY / 2n)
  // A burn lowers every limit in proportion (the hook reads the live supply).
  await assert.rejects(check(connection({ supply: SUPPLY / 2n }), 3, SUPPLY * 2n / 100n), /at most 2% of the supply/)
})

test('no fair ramp: nothing is read; an unreadable account: the hook decides', async () => {
  const conn = connection()
  await check(conn, 1, SUPPLY)
  await check(conn, null, SUPPLY)
  assert.equal(conn.reads.length, 0)
  await check(connection({ config: { ...mintConfig({}), owner: Keypair.generate().publicKey } }), 3, SUPPLY)
  await check(connection({ config: { ...mintConfig({}), data: Buffer.alloc(10) } }), 3, SUPPLY)
})
