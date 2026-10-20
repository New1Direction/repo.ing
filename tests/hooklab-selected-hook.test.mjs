import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { encodeHookAccountList } from '@repo-ing/hooklab-production-candidate'
import { selectedHookSchema, selectedHookAccountPlan, selectedHookAccountsHash, selectedHookOpenLaunchAccounts, selectedHookOpenLaunchInstruction, resolveSelectedHookRegistry } from '../src/hooklab-selected-hook.mjs'
import { nativeSwapV2Instruction, nativeSwapRequestSchema } from '../src/hooklab-native-swap.mjs'
import { loadNativeArtifacts, loadOpenArtifacts } from '../src/hooklab-native-pins.mjs'
import { inclusiveFeePolicyAddress } from '../src/hooklab-inclusive-fee-abi.mjs'
import { createNativeLaunchHandler } from '../app/lib/hooklab-native-launch.mjs'

const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58(), kb = x => new PublicKey(x).toBuffer()
const pda = (p, ...seeds) => PublicKey.findProgramAddressSync(seeds, new PublicKey(p))[0].toBase58()
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const sha = b => createHash('sha256').update(b).digest('hex')
function fixture() {
  const programs = { token: key(1), swap: key(2), launch: key(3), gate: key(4) }, hook = key(5), mint = key(6)
  const programDataAddress = pda(loader, kb(hook)), elf = Buffer.from([127, 69, 76, 70, 1, 2, 3, 4])
  const pb = Buffer.alloc(36); pb.writeUInt32LE(2); kb(programDataAddress).copy(pb, 4)
  const db = Buffer.alloc(45 + elf.length); db.writeUInt32LE(3); elf.copy(db, 45)
  const registry = { address: pda(hook, Buffer.from('bordrless-hook-accounts'), kb(mint)), owner: hook, executable: false,
    dataBase64: encodeHookAccountList({ version: 1, accounts: [
      { writable: true, source: { kind: 'key', key: new PublicKey(key(7)) } },
      { writable: false, source: { kind: 'pda', program: new PublicKey(hook), seeds: [
        { kind: 'literal', bytes: Buffer.from('test') }, { kind: 'account', index: 1 },
      ] } },
      { writable: false, source: { kind: 'key', key: new PublicKey(key(12)) } },
    ] }).toString('base64') }
  return { programs, stack: { kitProgram: key(13) }, mint, quoteMint: key(8), selectedHook: { program: hook, flags: 255 }, registry,
    programAccount: { address: hook, owner: loader, executable: true, dataBase64: pb.toString('base64') },
    programData: { address: programDataAddress, owner: loader, executable: false, dataBase64: db.toString('base64') }, elfSha256: sha(elf),
    callbackAccounts: [pda(programs.token, Buffer.from('hook-authority'), kb(hook)), mint, key(9), key(10), key(11)], sourceOwner: key(9), destinationOwner: key(10) }
}
test('selected hook resolves mint-stable launch keys using independent token/swap/launch identities', () => {
  const f = fixture(), p = selectedHookOpenLaunchAccounts(f), hook = f.selectedHook.program
  assert.equal(p.tokenSigner, pda(f.programs.token, Buffer.from('hook-authority'), kb(hook)))
  assert.notEqual(p.tokenSigner, pda(f.programs.launch, Buffer.from('hook-authority'), kb(hook)))
  assert.deepEqual(p.extras, [{ address: key(7), writable: true, signer: false },
    { address: pda(hook, Buffer.from('test'), kb(f.mint)), writable: false, signer: false },
    { address: key(12), writable: false, signer: false }])
  assert.deepEqual(p.remaining.map(x => x.address), [pda(f.programs.launch, Buffer.from('governance')), p.programData, hook, p.tokenSigner, f.registry.address,
    ...p.extras.map(x => x.address), inclusiveFeePolicyAddress(f.programs.swap, p.pool)])
  assert.equal(p.remaining.at(-1).writable, true); assert.equal(p.capBps, 0); assert.equal(p.feeModel, 2)
  assert.equal(p.canSign, false); assert.equal(p.canSubmit, false)
})
test('transfer registry resolves owners only from explicit context, never as launch-stable seeds', () => {
  const f = fixture(), hook = f.selectedHook.program
  f.registry.dataBase64 = encodeHookAccountList({ version: 1, accounts: [
    { writable: false, source: { kind: 'pda', program: new PublicKey(hook), seeds: [{ kind: 'sourceOwner' }, { kind: 'destinationOwner' }] } },
  ] }).toString('base64')
  assert.equal(selectedHookAccountPlan(f).extras[0].address, pda(hook, kb(f.sourceOwner), kb(f.destinationOwner)))
  assert.throws(() => selectedHookAccountPlan({ ...f, sourceOwner: undefined }))
  assert.throws(() => selectedHookAccountPlan({ ...f, destinationOwner: undefined }))
  assert.throws(() => selectedHookOpenLaunchAccounts(f), /mint-stable/)
})
test('commitment is domain plus Borsh tuple with exact ordered privileges and fee model', () => {
  const f = fixture(), p = selectedHookAccountPlan(f), raw = Buffer.from(f.registry.dataBase64, 'base64')
  const length = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const expected = Buffer.concat([Buffer.from('hook-lab:selected-hook-accounts:v1'), kb(p.hook), kb(f.registry.address), kb(f.registry.owner), length(raw.length), raw,
    length(3), ...p.extras.flatMap(x => [kb(x.address), Buffer.from([x.writable ? 1 : 0])]), Buffer.from([2])])
  assert.equal(p.commitment, sha(expected))
  const args = { hook: p.hook, registry: f.registry, extras: p.extras }
  assert.notEqual(selectedHookAccountsHash({ ...args, extras: [...p.extras].reverse() }).toString('hex'), p.commitment)
  assert.notEqual(selectedHookAccountsHash({ ...args, extras: p.extras.map(x => ({ ...x, writable: !x.writable })) }).toString('hex'), p.commitment)
  assert.throws(() => selectedHookAccountsHash({ ...args, feeModel: 1 }))
  assert.throws(() => selectedHookAccountsHash({ ...args, extras: [{ ...p.extras[0], signer: true }] }))
})
test('full known token flags accepted; unknown bits, Kit and caller approval fields refused', () => {
  for (let flags = 1; flags <= 255; flags++) assert.equal(selectedHookSchema.parse({ program: key(5), flags }).flags, flags)
  for (const flags of [0, -1, 256, 1985, 1.5]) assert.throws(() => selectedHookSchema.parse({ program: key(5), flags }))
  for (const extra of [{ kit: key(12) }, { approved: true }, { extras: [] }]) assert.throws(() => selectedHookSchema.parse({ program: key(5), flags: 1, ...extra }))
})
test('mutable, unpinned, aliased and mismatched hook accounts fail closed', () => {
  for (const mutate of [
    f => { const b = Buffer.from(f.programData.dataBase64, 'base64'); b[12] = 1; f.programData.dataBase64 = b.toString('base64') },
    f => { f.elfSha256 = '0'.repeat(64) }, f => { f.programData.owner = f.programs.token },
    f => { f.programAccount.address = f.programs.launch }, f => { f.programAccount.executable = false },
    f => { f.programData.address = f.programs.token }, f => { f.programs.token = f.programs.swap },
    f => { f.selectedHook.program = f.programs.gate }, f => { f.registry.owner = f.programs.launch },
    f => { f.registry.address = key(15) }, f => { f.registry.executable = true },
    f => { f.callbackAccounts = [] },
  ]) { const f = fixture(); mutate(f); assert.throws(() => selectedHookAccountPlan(f)) }
})
test('malformed registry versions, tags, booleans, trailing/truncated bytes are refused', () => {
  for (const edit of [b => { b[8] = 2; return b }, b => { b[13] = 2; return b }, b => { b[14] = 2; return b },
    b => Buffer.concat([b, Buffer.from([0])]), b => b.subarray(0, b.length - 1), b => { b.writeUInt32LE(33, 9); return b }]) {
    const f = fixture(); f.registry.dataBase64 = edit(Buffer.from(f.registry.dataBase64, 'base64')).toString('base64')
    assert.throws(() => resolveSelectedHookRegistry({ ...f, hook: f.selectedHook.program }))
  }
})
test('launch registry uses canonical signer/mint and earlier extras, refusing transfer-dependent seeds', () => {
  const f = fixture(), hook = f.selectedHook.program
  f.registry.dataBase64 = encodeHookAccountList({ version: 1, accounts: [
    { writable: true, source: { kind: 'key', key: new PublicKey(key(7)) } },
    { writable: false, source: { kind: 'pda', program: new PublicKey(hook), seeds: [
      { kind: 'account', index: 0 }, { kind: 'account', index: 1 }, { kind: 'account', index: 5 },
    ] } },
  ] }).toString('base64')
  const signer = pda(f.programs.token, Buffer.from('hook-authority'), kb(hook))
  const plan = selectedHookOpenLaunchAccounts(f)
  assert.equal(plan.extras[1].address, pda(hook, kb(signer), kb(f.mint), kb(key(7))))
  assert.equal(plan.extras.length, 2)
  for (const seed of [{ kind: 'sourceOwner' }, { kind: 'destinationOwner' },
    { kind: 'account', index: 2 }, { kind: 'account', index: 3 }, { kind: 'account', index: 4 }, { kind: 'account', index: 5 }]) {
    f.registry.dataBase64 = encodeHookAccountList({ version: 1, accounts: [
      { writable: false, source: { kind: 'pda', program: new PublicKey(hook), seeds: [seed] } },
    ] }).toString('base64')
    assert.throws(() => selectedHookOpenLaunchAccounts(f))
  }
  f.registry.dataBase64 = encodeHookAccountList({ version: 1, accounts: Array.from({ length: 5 }, () =>
    ({ writable: false, source: { kind: 'key', key: new PublicKey(key(7)) } })) }).toString('base64')
  assert.throws(() => selectedHookOpenLaunchAccounts(f), /four/)
})
test('selected open launch builds independent fixed accounts, exact guard and commitment, never gate extras', () => {
  const f = fixture(), idl = structuredClone(loadOpenArtifacts().idls.launch)
  idl.address = f.programs.launch
  const abi = idl.instructions.find(i => i.name === 'create_launch_open_v1')
  // Synthetic ABI fixture, not an operator approval or rewritten deployment pin.
  for (const a of abi.accounts) if (a.name !== 'system_program') delete a.address
  const guard = { version: 2, deadline_slot: new BN(500), expected_launch_economics_hash: [...Buffer.alloc(32, 12)],
    expected_pool_economics_hash: [...Buffer.alloc(32, 13)], max_launch_fee_lamports: new BN(20000000),
    max_pool_creation_fee_lamports: new BN(0), max_rent_lamports: new BN(100000000), max_total_debit_lamports: new BN(200000000) }
  const input = { ...f, creator: key(14), treasury: key(15), selectedConfig: key(16),
    args: { name: 'Selected', symbol: 'SEL', uri: '', creator_fee_bps: 100, virtual_quote: new BN('53250000000'),
      rules: { holder_fee_buy_bps: 0, holder_fee_sell_bps: 0, burn_buy_bps: 0, burn_sell_bps: 0, max_wallet_bps: 0, creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 } },
    guard, expectedControlHash: Buffer.alloc(32, 17) }
  const plan = selectedHookOpenLaunchAccounts(f), ix = selectedHookOpenLaunchInstruction(input, idl)
  assert.equal(ix.programId.toBase58(), f.programs.launch)
  assert.deepEqual(ix.keys.filter(m => m.isSigner).map(m => m.pubkey.toBase58()), [input.creator, f.mint])
  assert.deepEqual(ix.keys.slice(32).map(m => ({ address: m.pubkey.toBase58(), writable: m.isWritable, signer: m.isSigner })), plan.remaining)
  assert.equal(ix.keys[29].pubkey.toBase58(), input.selectedConfig)
  assert.equal(ix.keys[19].pubkey.toBase58(), f.programs.token)
  const data = new BorshCoder(idl).instruction.decode(ix.data).data
  assert.deepEqual([data.fee_model, data.quote_form], [2, 1])
  assert.deepEqual(Buffer.from(data.expected_hook_accounts_hash), Buffer.from(plan.commitment, 'hex'))
  assert.deepEqual(Buffer.from(data.expected_control_hash), input.expectedControlHash)
  assert.equal(data.guard.max_total_debit_lamports.toString(), '200000000')
  assert.throws(() => selectedHookOpenLaunchInstruction(input, loadOpenArtifacts().idls.launch), /identity/)
  assert.throws(() => selectedHookOpenLaunchInstruction({ ...input, expectedControlHash: Buffer.alloc(31) }, idl), /commitment/)
  assert.throws(() => selectedHookOpenLaunchInstruction({ ...input, args: { ...input.args, rules: { ...input.args.rules, max_wallet_bps: 200 } } }, idl), /rules/)
  const wrong = structuredClone(idl); wrong.instructions.find(i => i.name === abi.name).accounts[19].address = key(21)
  assert.throws(() => selectedHookOpenLaunchInstruction(input, wrong), /fixed address/)
})
test('buy/sell swap ABI uses registry slice with independently pinned IDs, policy last, no deterministic authorization', () => {
  const f = fixture(), idl = structuredClone(loadNativeArtifacts().idls.swap)
  idl.address = f.programs.swap
  // Fixed identity declarations in a reviewed stack IDL must agree too.
  for (const a of idl.instructions.find(x => x.name === 'swap_v2').accounts) {
    if (a.name === 'token_program') a.address = f.programs.token
  }
  const coder = new BorshCoder(idl), p = selectedHookOpenLaunchAccounts(f)
  for (const side of ['buy', 'sell']) {
    const ix = nativeSwapV2Instruction(f, { side, mint: f.mint, trader: key(11), amountIn: 42n, minAmountOut: 1n }, idl, f)
    assert.equal(ix.programId.toBase58(), f.programs.swap)
    assert.deepEqual(ix.keys.slice(15, 20).map(x => [x.pubkey.toBase58(), x.isWritable, x.isSigner]), p.transferSlice.map(x => [x.address, x.writable, false]))
    assert.equal(ix.keys.at(-1).pubkey.toBase58(), inclusiveFeePolicyAddress(f.programs.swap, p.pool))
    const args = coder.instruction.decode(ix.data).data.args
    assert.deepEqual([args.in_hook_accounts, args.out_hook_accounts], side === 'buy' ? [0, 5] : [5, 0])
  }
  const intent = { side: 'buy', mint: f.mint, trader: key(11), amountIn: 42n, minAmountOut: 1n }
  assert.throws(() => nativeSwapV2Instruction(f, intent, null, f), /IDL identity/)
  const wrongIdl = { ...idl, address: key(14) }
  assert.throws(() => nativeSwapV2Instruction(f, intent, wrongIdl, f), /IDL identity/)
  // Resolve transfer-dependent seeds from the actual buy/sell accounts, not caller-invented context.
  f.registry.dataBase64 = encodeHookAccountList({ version: 1, accounts: [
    { writable: false, source: { kind: 'pda', program: new PublicKey(f.selectedHook.program), seeds: [
      { kind: 'account', index: 2 }, { kind: 'account', index: 3 }, { kind: 'sourceOwner' }, { kind: 'destinationOwner' },
    ] } },
  ] }).toString('base64')
  const holding = (owner) => pda(f.programs.token, Buffer.from('holding'), kb(f.mint), kb(owner))
  for (const side of ['buy', 'sell']) {
    const ix = nativeSwapV2Instruction(f, { ...intent, side }, idl, f), buy = side === 'buy'
    const owners = buy ? [p.pool, intent.trader] : [intent.trader, p.pool]
    assert.equal(ix.keys[17].pubkey.toBase58(), pda(f.selectedHook.program, kb(holding(owners[0])), kb(holding(owners[1])), kb(owners[0]), kb(owners[1])))
  }
  assert.throws(() => nativeSwapRequestSchema.parse({ policyKind: 'selected-hook', selectedHook: f.selectedHook }))
})
test('HTTP selected-hook request has explicit blocker before custody/approval; invalid cap/flags are 400', async () => {
  let called = false
  const handler = createNativeLaunchHandler({ env: { HOOK_NATIVE_LAUNCH_ENABLED: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_OPEN_LAUNCHES: 'true' },
    configuration: () => ({ origin: 'https://repo.ing' }), database: () => ({ end: async () => {} }), quota: async () => true,
    principalStore: () => ({ resolve: async () => ({ wallet: key(11) }) }), runtime: () => ({ reserve: () => { called = true }, lifecycle: {} }) })
  const input = { action: 'reserve', operationId: '11111111-1111-4111-8111-111111111111', selectedHook: fixture().selectedHook, capBps: 0,
    label: 'test', name: 'test', symbol: 'T', uri: '', virtualQuote: '1', creatorFeeBps: 100 }
  const request = body => new Request('https://repo.ing/api/hook-lab/native-launch', { method: 'POST', headers: {
    origin: 'https://repo.ing', 'content-type': 'application/json', cookie: `__Host-hook-wallet-session=${Buffer.alloc(32, 9).toString('base64url')}` }, body: JSON.stringify(body) })
  const response = await handler(request(input)); assert.equal(response.status, 409)
  assert.equal((await response.json()).blockers[0].code, 'SELECTED_HOOK_REVIEW_UNAVAILABLE'); assert.equal(called, false)
  assert.equal((await handler(request({ ...input, capBps: 200 }))).status, 400)
  assert.equal((await handler(request({ ...input, selectedHook: { ...input.selectedHook, flags: 256 } }))).status, 400)
})
