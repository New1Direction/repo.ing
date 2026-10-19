// The owner agent and native-SOL launches: it co-signs create_launch_custom_v4 only with the native quote form, the mint's
// own launch, pool and fee policy, and only while its own two-provider read shows launch Config byte 186 on; v3 only while
// it is off. Every invite check still applies. Synthetic messages and keys; no RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import BN from 'bn.js'
import { BorshCoder } from '@anchor-lang/core'
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { policyAddress, verifyLaunchSignRequest } from '../src/hooklab-owner-agent.mjs'
import { readLiveNativeLaunches } from '../src/hooklab-launch-bounds.mjs'
import { verifyTableRequest } from '../src/hooklab-owner-launch-tables.mjs'
import { loadNativeArtifacts } from '../src/hooklab-native-pins.mjs'
import { PROGRAMS, QUOTE_MINT, derivedAddresses } from '../src/hooklab-owner-driver/pins.mjs'
import { maxWalletLaunchAccounts } from '../src/hooklab-max-wallet-launch.mjs'
import { productionArtifacts, productionProfileJson } from '../src/hooklab-production-operator-bundle.mjs'

const vendor = name => JSON.parse(readFileSync(new URL(`../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/${name}`, import.meta.url)))
const v3Coder = new BorshCoder(vendor('bordrless_launch.json')), gateCoder = new BorshCoder(vendor('hook_max_wallet.json')), v4Coder = loadNativeArtifacts().coders.launch
const key = label => Keypair.fromSeed(createHash('sha256').update(`OWNER AGENT NATIVE TEST ONLY ${label}`).digest()).publicKey
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), new PublicKey(program))[0]
const { launch: LAUNCH, gate: GATE, swap: SWAP } = PROGRAMS, admin = key('admin'), creator = key('creator'), mint = key('mint')
const approved = { launchProgram: LAUNCH, gateProgram: GATE, swapProgram: SWAP, quoteMint: QUOTE_MINT, admin: admin.toBase58(), creatorFeeChoices: [50, 100, 200], capChoices: [100, 200, 300, 500], feeModel: 2 }
const invited = { id: '5b7f4c1e-8a0f-4d55-9a49-3f7c0c2b9d11', status: 'launching', creator: creator.toBase58(), name: 'Native Coin', symbol: 'NAT', uri: '', creatorFeeBps: 100, capBps: 200, virtualQuote: '53251917070' }
const noRules = { holder_fee_buy_bps: 0, holder_fee_sell_bps: 0, burn_buy_bps: 0, burn_sell_bps: 0, max_wallet_bps: 0, creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 }
// The agent's own inputs: its pinned release envelope and the launch Config it read (the observed public mainnet bytes).
const { base, idls } = productionArtifacts(), envelope = { json: productionProfileJson(base), idls: Object.fromEntries(Object.entries(idls).map(([role, bytes]) => [role, bytes.toString('base64')])) }
const launchConfigBytes = Buffer.from(JSON.parse(readFileSync(new URL('./fixtures/hooklab-mainnet-public-accounts.json', import.meta.url))).accounts['launch-config'].dataBase64, 'base64')
const selectedConfig = key('selected config'), derived = maxWalletLaunchAccounts(envelope, { creator: creator.toBase58(), mint: mint.toBase58(), selectedConfig: selectedConfig.toBase58(), reviewer: admin.toBase58() }, launchConfigBytes)
// The compiler's exact 42 accounts (the admin reviewer at 34, the mint's fee policy last). change: { index: replacement
// pubkey, or { pubkey, isSigner, isWritable } }, and length to cut the list; the read-only accounts go in a lookup table.
function accounts(change = {}) {
  const list = derived.map((m, i) => { const c = change[i], meta = { pubkey: new PublicKey(m.address), isSigner: m.signer, isWritable: m.writable }
    return c === undefined ? meta : c instanceof PublicKey ? { ...meta, pubkey: c } : { ...meta, ...c } })
  return change.length === undefined ? list : list.slice(0, change.length)
}
const body = ({ virtualQuote = invited.virtualQuote, creatorFeeBps = 100, name = invited.name } = {}) => ({
  args: { name, symbol: invited.symbol, uri: invited.uri, creator_fee_bps: creatorFeeBps, virtual_quote: new BN(virtualQuote), rules: noRules },
  guard: { version: 2, deadline_slot: new BN(5000), expected_launch_economics_hash: Array(32).fill(1), expected_pool_economics_hash: Array(32).fill(2),
    max_launch_fee_lamports: new BN(0), max_pool_creation_fee_lamports: new BN(0), max_rent_lamports: new BN(1), max_total_debit_lamports: new BN(1) },
  fee_model: 2, expected_control_hash: Array(32).fill(3), expected_hook_accounts_hash: Array(32).fill(4) })
const v4Data = (quoteForm = 1, fields = {}) => v4Coder.instruction.encode('create_launch_custom_v4', { ...body(fields), quote_form: quoteForm })
function signRequest({ route = 'v4', quoteForm = 1, data: override, keys = accounts(), ...fields } = {}) {
  const data = override ?? (route === 'v4' ? v4Data(quoteForm, fields) : v3Coder.instruction.encode('create_launch_custom_v3', body(fields)))
  const readOnly = [...new Set(keys.filter(k => !k.isSigner && !k.isWritable).map(k => k.pubkey.toBase58()))].map(k => new PublicKey(k))
  const table = new AddressLookupTableAccount({ key: key('table'), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: admin, addresses: readOnly } })
  const message = new TransactionMessage({ payerKey: creator, recentBlockhash: key('blockhash').toBase58(), instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    new TransactionInstruction({ programId: new PublicKey(LAUNCH), keys, data })] }).compileToV0Message([table])
  const bytes = Buffer.from(message.serialize())
  return { table, request: { messageBase64: bytes.toString('base64'), messageSha256: createHash('sha256').update(bytes).digest('hex'), signer: admin.toBase58(), validUntilSlot: '5000', lastValidBlockHeight: '9000' } }
}
const policy = async (cap = 200) => ({ address: policyAddress(GATE, mint.toBase58()), owner: GATE, data: await gateCoder.accounts.encode('PolicyV2', { version: 2, mint, initial_supply: new BN('1000000000000000'),
  cap_bps: cap, quote_mint: new PublicKey(QUOTE_MINT), lp_fee_bps: 0, fee_model: 2, protocol_share_bps: 2500, creator_fee_bps: 100 }) })
// The creator's prepared launch config, as the agent reads it itself.
const selected = async (fields = {}) => ({ address: selectedConfig.toBase58(), owner: LAUNCH, data: await v3Coder.accounts.encode('LaunchConfig', { version: 1, creator, rules: noRules,
  creator_fee_bps: 100, custom_hook: new PublicKey(GATE), custom_hook_flags: 1, label: 'NAT', created_at: new BN(1), author_share_bps: 0, reserved: Array(30).fill(0), ...fields }) })
const verify = async (built, { nativeLaunches = true, cap, over = {}, approve = approved, config = launchConfigBytes, launchConfig } = {}) =>
  verifyLaunchSignRequest({ signRequest: built.request, invited: { ...invited, ...over }, approved: approve, lookupTables: [built.table], policy: await policy(cap), live: { slot: 100, blockHeight: 100 }, nativeLaunches,
    envelope, launchConfigBytes: config, selectedConfig: launchConfig === undefined ? await selected() : launchConfig })
const DERIVED = /launch accounts differ from the ones this agent derives/

test('switch on: the agent co-signs a v4 launch with the native quote form at the mint\'s own addresses', async () => {
  const checked = await verify(signRequest())
  assert.equal(checked.quoteForm, 1); assert.equal(checked.virtualQuote, invited.virtualQuote); assert.equal(checked.mint, mint.toBase58())
})

test('the agent\'s own switch reading decides the route: v3 while on, or v4 while off, is refused', async () => {
  await assert.rejects(verify(signRequest({ route: 'v3' })), /native launches are on: refusing a bridged create_launch_custom_v3/)
  await assert.rejects(verify(signRequest(), { nativeLaunches: false }), /native launches are off on chain: refusing create_launch_custom_v4/)
  assert.equal((await verify(signRequest({ route: 'v3' }), { nativeLaunches: false })).quoteForm, null, 'switch off: v3 exactly as before')
  for (const reading of [null, 'true', 1]) await assert.rejects(verify(signRequest(), { nativeLaunches: reading }), /switch was not read/, String(reading))
})

test('tampering refuses: quote form, discriminator, non-canonical data, a wrong pool, launch or fee policy', async () => {
  for (const quoteForm of [0, 2, 255]) await assert.rejects(verify(signRequest({ quoteForm })), /quote form is not native SOL/, `form ${quoteForm}`)
  const v4 = v4Data(), swapped = Buffer.concat([v3Coder.instruction.encode('create_launch_custom_v3', body()).subarray(0, 8), v4.subarray(8)])
  await assert.rejects(verify(signRequest({ data: swapped })), /refusing a bridged create_launch_custom_v3/, 'v4 body under the v3 discriminator')
  const unknown = Buffer.from(v4); unknown[0] ^= 1
  await assert.rejects(verify(signRequest({ data: unknown })), /instruction is not create_launch_custom_v4/)
  await assert.rejects(verify(signRequest({ data: Buffer.concat([v4, Buffer.from([0])]) })), /not canonical/, 'trailing bytes')
  const other = key('other'), otherPool = pda(SWAP, 'pool', other.toBuffer(), new PublicKey(QUOTE_MINT).toBuffer(), Buffer.alloc(2), new PublicKey(LAUNCH).toBuffer())
  for (const [index, wrong, label] of [[10, otherPool, 'another mint\'s pool'], [10, pda(SWAP, 'pool', mint.toBuffer(), new PublicKey(QUOTE_MINT).toBuffer(), Buffer.from([1, 0]), new PublicKey(LAUNCH).toBuffer()), 'a pool with another LP fee'],
    [4, pda(LAUNCH, 'launch', other.toBuffer()), 'another launch'], [41, pda(SWAP, 'inclusive-fee-policy', otherPool.toBuffer()), 'another fee policy'], [7, other, 'another quote mint']])
    await assert.rejects(verify(signRequest({ keys: accounts({ [index]: wrong }) })), DERIVED, label)
  await assert.rejects(verify(signRequest({ keys: accounts({ length: 41 }) })), DERIVED, 'a short account list')
  await assert.rejects(verify(signRequest({ keys: [...accounts(), { pubkey: key('extra'), isSigner: false, isWritable: false }] })), DERIVED, 'an extra account')
})

test('every invite check still applies to a v4 launch', async () => {
  await assert.rejects(verify(signRequest({ virtualQuote: '53251917071' })), /opening price \(virtual quote\) differs/)
  await assert.rejects(verify(signRequest({ creatorFeeBps: 200 })), /creator fee or fee model differs/)
  await assert.rejects(verify(signRequest({ name: 'Other' })), /coin name, symbol or URI differs/)
  await assert.rejects(verify(signRequest(), { cap: 500 }), /on-chain wallet cap or fee policy differs/)
  await assert.rejects(verify(signRequest({ keys: accounts({ 0: key('someone') }) })), /fee payer is not the invited creator|launch creator is not the invited creator/)
  await assert.rejects(verify(signRequest(), { over: { capBps: 700 } }), /not an approved choice/)
})

test('the agent reads byte 186 from both providers: agreeing 0 or 1 only', async () => {
  const config = switchByte => { const b = Buffer.alloc(250); createHash('sha256').update('account:Config').digest().copy(b, 0, 0, 8); b[186] = switchByte; return b }
  const provider = data => ({ async getAccountInfo(address, commitment) { assert.equal(address.toBase58(), derivedAddresses().launchConfig); assert.equal(commitment, 'finalized'); return { owner: new PublicKey(LAUNCH), data } } })
  assert.equal(await readLiveNativeLaunches([provider(config(1)), provider(config(1))]), true)
  assert.equal(await readLiveNativeLaunches([provider(config(0)), provider(config(0))]), false)
  await assert.rejects(readLiveNativeLaunches([provider(config(1)), provider(config(0))]), /providers disagree/)
  await assert.rejects(readLiveNativeLaunches([provider(config(2)), provider(config(2))]), error => error.code === 'LAUNCH_PRICE_REFUSED' && /byte 186 is 2.*not signing any launch/.test(error.message))
  await assert.rejects(readLiveNativeLaunches([provider(config(1))]), /Two RPC providers/)
})

test('a table request reports the route from the agent\'s own config read and refuses an impossible switch byte', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/hooklab-mainnet-public-accounts.json', import.meta.url)))
  const live = Buffer.from(fixture.accounts['launch-config'].dataBase64, 'base64'), on = Buffer.from(live); on[186] = 1
  const bad = Buffer.from(live); bad[186] = 7
  for (const [bytes, expected] of [[live, false], [on, true]]) assert.throws(() => verifyTableRequest({ tableRequest: { launchRequest: {} }, invited: null, envelope: null, launchConfigBytes: bytes, adminAddress: approved.admin }),
    /No launching request/, `switch ${expected}: reads, then the usual checks`)
  assert.throws(() => verifyTableRequest({ tableRequest: { launchRequest: {} }, invited: null, envelope: null, launchConfigBytes: bad, adminAddress: approved.admin }), /byte 186 is 7.*no table is paid for/)
})

// Review F3 (defence in depth for the admin key): the agent derives all 42 accounts, with their signer and writable flags,
// from its own launch Config read and pinned envelope, and requires the message to match them exactly, both routes.
test('F3: a substituted treasury, config, governance or token program, or a changed privilege, is refused on both routes', async () => {
  for (const route of ['v4', 'v3']) {
    const nativeLaunches = route === 'v4', other = key(`substitute ${route}`)
    assert.equal((await verify(signRequest({ route }), { nativeLaunches })).mint, mint.toBase58(), `${route}: the exact derived list is accepted`)
    for (const [index, label] of [[2, 'treasury'], [1, 'launch config'], [9, 'dex config'], [32, 'launch governance'], [19, 'token program'], [18, 'swap program']])
      await assert.rejects(verify(signRequest({ route, keys: accounts({ [index]: other }) }), { nativeLaunches }), DERIVED, `${route}: substituted ${label}`)
    await assert.rejects(verify(signRequest({ route, keys: accounts({ 29: other }) }), { nativeLaunches }), /selected launch config is not one this agent read/, `${route}: substituted selected config`)
    await assert.rejects(verify(signRequest({ route, keys: accounts({ 2: { isWritable: false } }) }), { nativeLaunches }), DERIVED, `${route}: treasury made read-only`)
    await assert.rejects(verify(signRequest({ route, keys: accounts({ 33: { isWritable: false } }) }), { nativeLaunches }), DERIVED, `${route}: creator grant made read-only`)
    // The treasury the agent expects is the one in ITS config read, not one the server picks.
    const moved = Buffer.from(launchConfigBytes); new PublicKey(other).toBuffer().copy(moved, 8 + 1 + 1 + 32)
    await assert.rejects(verify(signRequest({ route }), { nativeLaunches, config: moved }), DERIVED, `${route}: a config read with another treasury`)
  }
  await assert.rejects(verify(signRequest(), { config: null }), /cannot derive the launch accounts/, 'no config read: nothing is signed')
  await assert.rejects(verify(signRequest(), { launchConfig: null }), /not one this agent read/, 'no selected config read')
  for (const fields of [{ creator: key('someone') }, { creator_fee_bps: 200 }, { custom_hook: key('hook') }, { author_share_bps: 1 }])
    await assert.rejects(verify(signRequest(), { launchConfig: await selected(fields) }), /not the invited creator's, with the invited fee and the gate/, JSON.stringify(Object.keys(fields)))
})
