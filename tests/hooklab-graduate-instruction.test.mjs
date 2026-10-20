// The permissionless `graduate` instruction for a Hooks coin, pinned to the deployed launch IDL and to derivations made
// independently here (raw findProgramAddressSync), the swap compiler's and the launch program's own client order
// (hook-lab programs/bordrless_launch/src/client.rs graduate_with). Built only: nothing sends it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
import { graduateHookCoin, instructionsFor } from '../src/hooklab-owner-driver/instructions.mjs'
import { loadArtifacts } from '../src/hooklab-owner-driver/artifacts.mjs'
import { stackFromIndependentBuild } from '../src/hooklab-stack-build.mjs'
import { INDEPENDENT_DIR, INDEPENDENT_SKIP } from './fixtures/hooklab-independent-stack.mjs'
import { MAINNET_ROLES, PROGRAMS, QUOTE_MINT } from '../src/hooklab-owner-driver/pins.mjs'
import { LEGACY_KIT } from '../src/hooklab-stack.mjs'
import { hookCoinAddresses } from '../src/hooklab-inclusive-max-wallet-swap.mjs'

const idl = JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/bordrless_launch.json', import.meta.url)))
const definition = idl.instructions.find(ix => ix.name === 'graduate')
const key = v => new PublicKey(v).toBuffer(), seed = s => typeof s === 'string' ? Buffer.from(s) : s
const find = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(seed), new PublicKey(program))[0].toBase58()
const { launch: L, swap: S, gate: G, token: T } = PROGRAMS, KIT = 'AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm'

function expected(mint) {
  const launch = find(L, 'launch', key(mint)), pool = find(S, 'pool', key(mint), key(QUOTE_MINT), Buffer.from([0, 0]), key(L)), lpMint = find(S, 'lp', key(pool))
  const holding = (m, owner) => find(T, 'holding', key(m), key(owner))
  return { launch, pool, lpMint, accounts: [
    ['cranker', 'CRANKER', 's'], ['launch', launch, 'w'], ['mint', mint, 'w'], ['quote_mint', QUOTE_MINT, ''], ['pool', pool, 'w'],
    ['launch_reserve', holding(mint, launch), 'w'], ['base_vault', holding(mint, pool), 'w'], ['quote_vault', holding(QUOTE_MINT, pool), ''], ['lp_mint', lpMint, 'w'],
    ['launch_lp', holding(lpMint, launch), 'w'], ['hook_signer', find(L, 'hook-authority'), ''], ['swap_program', S, ''], ['dex_event_authority', find(S, '__event_authority'), ''],
    ['token_program', T, ''], ['token_hook_signer', find(T, 'hook-authority', key(KIT)), ''], ['token_event_authority', find(T, '__event_authority'), ''],
    // No kit: each optional kit account is absent, which Anchor reads from the program's own id (read-only).
    ['kit_program', L, ''], ['kit_config', L, ''], ['reward_vault', L, ''], ['kit_caller', L, ''], ['kit_event_authority', L, ''],
    ['event_authority', find(L, '__event_authority'), ''], ['program', L, ''],
    // The custom hook's slice: the max-wallet gate, the token program's signer for it, then its registry's extras.
    ['gate', G, ''], ['gate_hook_signer', find(T, 'hook-authority', key(G)), ''], ['policy', find(G, 'policy-v2', key(mint)), ''], ['launch (extra)', launch, ''],
  ] }
}

test('graduate: every account, its order and privileges, and the data match the deployed IDL and independent derivations', () => {
  const cranker = Keypair.generate().publicKey.toBase58()
  for (const mint of [MAINNET_ROLES.mint, Keypair.generate().publicKey.toBase58()]) {
    const ix = graduateHookCoin(PROGRAMS, QUOTE_MINT, { cranker, mint, kit: LEGACY_KIT }), want = expected(mint)
    assert.equal(ix.programId.toBase58(), L)
    assert.deepEqual([...ix.data], definition.discriminator); assert.equal(definition.args.length, 0)
    assert.deepEqual(ix.data, createHash('sha256').update('global:graduate').digest().subarray(0, 8))
    assert.deepEqual(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner ? 's' : k.isWritable ? 'w' : '']),
      want.accounts.map(([, address, flags]) => [address === 'CRANKER' ? cranker : address, flags]))
    assert.deepEqual(want.accounts.slice(0, definition.accounts.length).map(([name]) => name), definition.accounts.map(a => a.name), 'IDL order')
    definition.accounts.forEach((a, i) => {
      if (a.address) assert.equal(ix.keys[i].pubkey.toBase58(), a.address, `${a.name} is the IDL's fixed address`)
      assert.equal(ix.keys[i].isSigner, !!a.signer, a.name)
      assert.equal(ix.keys[i].isWritable, !!a.writable && !a.optional, a.name)
    })
    const shared = hookCoinAddresses({ programs: PROGRAMS, quoteMint: QUOTE_MINT }, mint), at = name => ix.keys[definition.accounts.findIndex(a => a.name === name)].pubkey.toBase58()
    assert.deepEqual([at('launch'), at('pool'), at('lp_mint'), at('launch_reserve'), at('launch_lp'), at('base_vault'), at('quote_vault')],
      [shared.launch, shared.pool, shared.lpMint, shared.launchReserve, shared.launchLp, shared.baseVault, shared.quoteVault], 'the swap compiler derives the same accounts')
    assert.deepEqual(ix.keys.slice(-4).map(k => k.pubkey.toBase58()), [G, shared.gateHookSigner, shared.policy, shared.launch])
  }
})

test('graduate refuses addresses that are not keys', () => {
  assert.throws(() => graduateHookCoin(PROGRAMS, QUOTE_MINT, { cranker: 'nope', mint: MAINNET_ROLES.mint, kit: LEGACY_KIT }))
  assert.throws(() => graduateHookCoin(PROGRAMS, QUOTE_MINT, { cranker: MAINNET_ROLES.payer, mint: 'nope', kit: LEGACY_KIT }))
})

// Regression (self-serve e2e on hook-lab independent e775165, 2026-10-19): that build's launch program takes the token
// program's hook signer for the GATE as graduate's token_hook_signer (manifest TOKEN_HOOK_AUTHORITY), where bundle 2 and
// earlier builds take the signer for the kit. graduate follows the launch IDL's fixed address, and only those two.
test('graduate on our own stack uses the launch IDL\'s token hook signer: the kit\'s or the gate\'s, never another', { skip: INDEPENDENT_SKIP }, async () => {
  const { stack, idls } = stackFromIndependentBuild(INDEPENDENT_DIR), launchIdl = JSON.parse(idls.launch)
  const { launch: L2, swap: S2, gate: G2, token: T2 } = stack.programs, cranker = Keypair.generate().publicKey.toBase58(), mint = Keypair.generate().publicKey.toBase58()
  const builders = idl => instructionsFor({ idls: { ...loadArtifacts().idls, launch: idl }, coders: { ...loadArtifacts().coders, launch: new BorshCoder(idl) } })
  const fixed = launchIdl.instructions.find(ix => ix.name === 'graduate').accounts.find(a => a.name === 'token_hook_signer').address
  assert.ok([find(T2, 'hook-authority', key(stack.kitProgram)), find(T2, 'hook-authority', key(G2))].includes(fixed), 'the build names one of the two')
  const ix = builders(launchIdl).graduateHookCoin(stack.programs, stack.quoteMint, { cranker, mint, kit: stack.kitProgram })
  assert.equal(ix.keys[14].pubkey.toBase58(), fixed); assert.equal(ix.programId.toBase58(), L2)
  assert.deepEqual(ix.keys.slice(-4).map(k => k.pubkey.toBase58()), [G2, find(T2, 'hook-authority', key(G2)), find(G2, 'policy-v2', key(mint)), find(L2, 'launch', key(mint))])
  // An IDL naming any other token hook signer is refused.
  const tampered = structuredClone(launchIdl)
  tampered.instructions.find(ix => ix.name === 'graduate').accounts.find(a => a.name === 'token_hook_signer').address = find(T2, 'hook-authority', key(S2))
  assert.throws(() => builders(tampered).graduateHookCoin(stack.programs, stack.quoteMint, { cranker, mint, kit: stack.kitProgram }), /token_hook_signer differs/)
})
