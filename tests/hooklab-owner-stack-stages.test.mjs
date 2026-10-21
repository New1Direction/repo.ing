// The owner driver on our own stack (--stack): instruction builders bound to the stack's IDLs, the stack's artifacts and
// envelope, the stage guards, and the decisions the new stages take. No RPC; the relocated stack's IDLs are read only
// when its ELFs are present.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { Keypair, PublicKey } from '@solana/web3.js'
import { instructionsFor } from '../src/hooklab-owner-driver/instructions.mjs'
import { loadArtifacts, loadStackArtifacts, stackCompilerEnvelope, STACK_IDL_FILES } from '../src/hooklab-owner-driver/artifacts.mjs'
import { loadConfig, assertExecutable, unapproved, missing, STAGE_DECISIONS } from '../src/hooklab-owner-driver/config.mjs'
import { createContext, assertStageForStack, STAGES, STACK_STAGE_ORDER } from '../src/hooklab-owner-driver/context.mjs'
import { parseArgs } from '../src/hooklab-owner-driver/cli.mjs'
import { derivedAddresses, pda, kb, MAINNET_GENESIS, LOADER, SYSTEM } from '../src/hooklab-owner-driver/pins.mjs'
import { LAUNCH_CONFIG_START, collectNative } from '../src/hooklab-owner-driver/stages/stack.mjs'
import { OWNER_CREATION_FEE_LAMPORTS } from '../src/hooklab-owner-driver/stages/open-creation.mjs'
import { ownStack, OWN_STACK_SKIP, PLACEHOLDER_IDS } from './fixtures/hooklab-own-stack.mjs'
import { independentStack, INDEPENDENT_SKIP } from './fixtures/hooklab-independent-stack.mjs'
import { selectedNativeTradeFixture } from './fixtures/selected-native-trade.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest()
const scratch = mkdtempSync(path.join(tmpdir(), 'hooklab-owner-stack-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const programs = { launch: PLACEHOLDER_IDS.launch, swap: PLACEHOLDER_IDS.swap, gate: PLACEHOLDER_IDS.gate, token: PLACEHOLDER_IDS.token }
const key = () => Keypair.generate().publicKey.toBase58()
const flags = ix => ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable])
// The relocated stack's IDLs on disk, as --stack-idls reads them.
function stackFiles(stack = ownStack()) {
  const dir = mkdtempSync(path.join(scratch, 'stack-')), idlDir = path.join(dir, 'idl'); mkdirSync(idlDir)
  for (const [role, file] of Object.entries(STACK_IDL_FILES)) writeFileSync(path.join(idlDir, file), stack.idls[role])
  writeFileSync(path.join(dir, 'stack.json'), JSON.stringify(stack.stack))
  return { ...stack, idlDir, stackPath: path.join(dir, 'stack.json') }
}

test('collect_protocol_fees_native: the discriminator alone, then cranker, config, pool, collector, event authority, program and the fee policy', () => {
  const mint = key(), cranker = key(), collector = key(), ix = instructionsFor(loadArtifacts).collectProtocolFeesNative(programs, PLACEHOLDER_IDS.quoteMint, { cranker, mint, collector })
  const pool = pda(programs.swap, 'pool', kb(mint), kb(PLACEHOLDER_IDS.quoteMint), Buffer.alloc(2), kb(programs.launch)), d = derivedAddresses(programs, PLACEHOLDER_IDS.quoteMint)
  assert.equal(ix.programId.toBase58(), programs.swap)
  assert.deepEqual(ix.data, sha(Buffer.from('global:collect_protocol_fees_native')).subarray(0, 8))
  assert.deepEqual(flags(ix), [[cranker, true, false], [d.swapConfig, false, false], [pool, false, true], [collector, false, true], [d.swapEventAuthority, false, false],
    [programs.swap, false, false], [pda(programs.swap, 'inclusive-fee-policy', kb(pool)), false, false]])
  const shared = instructionsFor(loadArtifacts).collectProtocolFeesNative(programs, PLACEHOLDER_IDS.quoteMint, { cranker, mint, collector, feeModel: 1 })
  assert.deepEqual(flags(shared), flags(ix).slice(0, 6))
  assert.deepEqual(shared.data, ix.data)
  assert.throws(() => instructionsFor(loadArtifacts).collectProtocolFeesNative(programs, PLACEHOLDER_IDS.quoteMint, { cranker, mint, collector, feeModel: 0 }), /fee model/i)
  // An IDL that declares it differently is refused; one that matches is accepted.
  const legacy = loadArtifacts(), withDefinition = accounts => ({ ...legacy, idls: { ...legacy.idls, swap: { ...legacy.idls.swap, instructions: [...legacy.idls.swap.instructions,
    { name: 'collect_protocol_fees_native', discriminator: [...ix.data], accounts, args: [] }] } } })
  const good = [{ name: 'cranker', signer: true }, { name: 'config' }, { name: 'pool', writable: true }, { name: 'collector', writable: true }, { name: 'event_authority' }, { name: 'program' }]
  assert.doesNotThrow(() => instructionsFor(withDefinition(good)).collectProtocolFeesNative(programs, PLACEHOLDER_IDS.quoteMint, { cranker, mint, collector }))
  assert.throws(() => instructionsFor(withDefinition(good.map((a, i) => i === 3 ? { name: 'collector' } : a))).collectProtocolFeesNative(programs, PLACEHOLDER_IDS.quoteMint, { cranker, mint, collector }), /ABI differs/)
})

test('native collection selects the observed pool model; only inclusive pools require their policy', async () => {
  for (const feeModel of [1, 2]) {
    const f = selectedNativeTradeFixture('buy', { feeModel }), d = derivedAddresses(f.p.programs, f.p.quoteMint)
    const config = f.coders.swap.accounts.decode('Config', Buffer.from(f.accounts.get(d.swapConfig).dataBase64, 'base64'))
    const abi = { coders: f.coders, idls: Object.fromEntries(Object.entries(f.input.profile.idls).map(([role, bytes]) => [role, JSON.parse(Buffer.from(bytes, 'base64'))])) }
    abi.idls.swap.instructions.push({ name: 'collect_protocol_fees_native', args: [], discriminator: [...sha(Buffer.from('global:collect_protocol_fees_native')).subarray(0, 8)],
      accounts: [{ name: 'cranker', signer: true }, { name: 'config' }, { name: 'pool', writable: true }, { name: 'collector', writable: true }, { name: 'event_authority' }, { name: 'program' }] })
    const ctx = { stack: {}, programs: f.p.programs, quoteMint: f.p.quoteMint, genesis: f.p.genesisHash, abi, ix: instructionsFor(abi),
      options: { mint: f.request.mint }, roles: { payer: f.request.trader, treasury: config.fee_collector.toBase58() },
      readers: [0, 1].map(() => ({ connection: { getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: 100 }, value: keys.map(k => {
        const a = f.accounts.get(k.toBase58()); return a ? { owner: new PublicKey(a.owner), executable: a.executable, lamports: Number(a.lamports), data: Buffer.from(a.dataBase64, 'base64') } : null
      }) }) } })) }
    assert.match((await collectNative.build(ctx)).blocked, /nothing to collect/)
    const policy = pda(f.p.programs.swap, 'inclusive-fee-policy', kb(f.a.pool))
    f.accounts.delete(policy)
    if (feeModel === 2) await assert.rejects(collectNative.build(ctx), /inclusive fee policy/)
    else assert.match((await collectNative.build(ctx)).blocked, /nothing to collect/)
  }
})

test('first-time setup builders: init_config_v2, init_governance and the guardian Pause, exactly as the stack IDL encodes them', { skip: OWN_STACK_SKIP }, () => {
  const { idls } = ownStack(), abi = { idls: Object.fromEntries(Object.entries(idls).map(([r, b]) => [r, JSON.parse(b)])), coders: {} }
  for (const role of ['launch', 'swap', 'gate']) abi.coders[role] = new BorshCoder(abi.idls[role])
  const ix = instructionsFor(abi), d = derivedAddresses(programs, PLACEHOLDER_IDS.quoteMint), upgrade = key(), payer = key(), admin = key(), guardian = key(), treasury = key()
  const args = { admin: new PublicKey(admin), protocol_fee_bps: 0, fee_collector: new PublicKey(treasury), treasury: new PublicKey(treasury), pool_creation_fee_lamports: new BN(0), paused: true, launch_protocol_share_bps: 0 }
  const init = ix.initConfig(programs, 'swap', { authority: upgrade, payer, args })
  assert.deepEqual(flags(init), [[upgrade, true, false], [payer, true, true], [d.swapConfig, false, true], [d.swapProgramData, false, false], [SYSTEM, false, false], [d.swapEventAuthority, false, false], [programs.swap, false, false]])
  assert.equal(abi.coders.swap.instruction.decode(init.data).name, 'init_config_v2')
  const custody = Buffer.alloc(32, 7), gov = ix.initGovernance(programs, 'launch', { admin, payer, genesis: MAINNET_GENESIS, guardian, custodyDigest: custody })
  assert.deepEqual(flags(gov), [[admin, true, false], [payer, true, true], [d.launchConfig, false, false], [d.launchGovernance, false, true], [d.launchProgramData, false, false], [SYSTEM, false, false]])
  const decoded = abi.coders.launch.instruction.decode(gov.data)
  assert.equal(decoded.name, 'init_governance'); assert.equal(decoded.data.args.guardian.toBase58(), guardian)
  assert.deepEqual(Buffer.from(decoded.data.args.custody_digest), custody); assert.deepEqual(Buffer.from(decoded.data.args.genesis), new PublicKey(MAINNET_GENESIS).toBuffer())
  const pause = ix.governancePause(programs, 'swap', guardian, Buffer.alloc(32, 1), { creation: false, trading: true })
  assert.deepEqual(flags(pause), [[guardian, true, false], [d.swapConfig, false, true], [d.swapGovernance, false, true]])
  const action = abi.coders.swap.instruction.decode(pause.data).data.action
  assert.deepEqual(action, { Pause: { 0: { creation: false, trading: true } } })
  assert.throws(() => ix.governancePause(programs, 'swap', guardian, Buffer.alloc(32, 1), { creation: false, trading: false }), /closes at least one gate/)
})

test('the stack\'s artifacts: its IDLs must be its build\'s and name its programs; the envelope is its profile; pins are trimmed', { skip: OWN_STACK_SKIP }, () => {
  const files = stackFiles(), artifacts = loadStackArtifacts(files.stack, files.idlDir)
  assert.deepEqual(artifacts.elf.launch, { sha256: files.stack.build.elf.launch.trimmedSha256, length: files.stack.build.elf.launch.trimmedLength })
  assert.equal(artifacts.idls.launch.address, files.stack.programs.launch); assert.equal(artifacts.profile.quoteMint, files.stack.quoteMint)
  const local = stackCompilerEnvelope(artifacts, { genesisHash: 'localgenesis1111111111111111111111111111111', providers: ['a', 'b'], local: true }), profile = JSON.parse(local.json)
  assert.equal(profile.schema, 'hook-lab/local-inclusive-max-wallet-builder-profile/1'); assert.equal(profile.programs.bridge, undefined); assert.equal(profile.stack.id, files.stack.id)
  assert.equal(Buffer.from(local.idls.swap, 'base64').toString(), files.idls.swap.toString())
  assert.throws(() => stackCompilerEnvelope(artifacts, { genesisHash: 'localgenesis1111111111111111111111111111111', providers: ['a', 'b'], local: false }), /mainnet genesis/)
  // Another build's IDL in the directory is refused.
  writeFileSync(path.join(files.idlDir, 'bordrless_swap.json'), readFileSync(new URL('../vendor/hooklab-native-candidate/bordrless_swap.json', import.meta.url)))
  assert.throws(() => loadStackArtifacts(files.stack, files.idlDir), /swap IDL differs/)
  assert.throws(() => loadStackArtifacts(files.stack, null), /--stack-idls/)
})

test('a placeholder stack never runs on mainnet, and the upgrade role must be the stack\'s', { skip: OWN_STACK_SKIP }, async () => {
  const files = stackFiles(), config = new URL('../hooklab-owner.config.json', import.meta.url).pathname
  const base = { configPath: config, runsRoot: path.join(scratch, 'runs'), journalRoot: path.join(scratch, 'journal'), stackPath: files.stackPath, stackIdlDir: files.idlDir }
  await assert.rejects(createContext(base), /placeholder/)
  const reviewed = stackFiles({ ...files, stack: { ...files.stack, status: 'reviewed', upgradeAuthority: Keypair.generate().publicKey.toBase58() } })
  await assert.rejects(createContext({ ...base, stackPath: reviewed.stackPath, stackIdlDir: reviewed.idlDir }), /upgrade role .* is not the stack's upgrade authority/)
})

test('stage guards: legacy-only stages refuse --stack, stack setup stages need it', () => {
  for (const stage of ['canary-launch', 'grant', 'customer-grant', 'collect', 'alt']) assert.throws(() => assertStageForStack(stage, true), /legacy stack only/)
  for (const stage of ['stack-verify', 'quote-marker', 'launch-config-init', 'swap-governance-init', 'collect-native']) assert.throws(() => assertStageForStack(stage, false), /sets up our own stack/)
  assert.throws(() => parseArgs(['plan', 'customer-grant', '--stack', 'x.json', '--creator', key()]), /legacy stack only/)
  assert.throws(() => parseArgs(['plan', 'launch-config-init']), /--stack FILE/)
  const args = parseArgs(['plan', 'guardian-pause', '--pause', 'both', '--stack', 's.json', '--stack-idls', 'idl'])
  assert.equal(args.pause, 'both'); assert.equal(args.stack, 's.json'); assert.equal(args['stack-idls'], 'idl')
  for (const stage of STACK_STAGE_ORDER) assert.ok(STAGES[stage], stage)
})

test('decisions: the creation fee defaults to the owner-confirmed 0.02 SOL; menus and the custody digest are never defaulted', () => {
  const template = JSON.parse(readFileSync(new URL('../hooklab-owner.config.json', import.meta.url))), dir = mkdtempSync(path.join(scratch, 'cfg-'))
  const write = (name, value) => { const file = path.join(dir, name); writeFileSync(file, JSON.stringify(value)); return loadConfig(file) }
  for (const decision of Object.values(template.decisions)) decision.approved = true
  const config = write('a.json', template)
  assert.equal(OWNER_CREATION_FEE_LAMPORTS, '20000000')
  assert.doesNotThrow(() => assertExecutable(config, 'launch-fee'), 'no launchFeeLamports decision: the owner-confirmed default applies')
  assert.deepEqual(missing(config, 'open-creation'), ['openCreationMenus']); assert.deepEqual(missing(config, 'launch-governance-init'), ['stackCustodyDigest'])
  const unapprovedFee = write('b.json', { ...template, decisions: { ...template.decisions, launchFeeLamports: { value: '30000000', approved: false } } })
  assert.deepEqual(unapproved(unapprovedFee, 'launch-fee'), ['launchFeeLamports'], 'a decision in the file must be approved; the default never overrides it')
  const menus = write('c.json', { ...template, decisions: { ...template.decisions, openCreationMenus: { value: { creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] }, approved: true },
    stackCustodyDigest: { value: 'ab'.repeat(32), approved: true } } })
  assert.doesNotThrow(() => assertExecutable(menus, 'open-creation')); assert.doesNotThrow(() => assertExecutable(menus, 'swap-governance-init'))
  assert.throws(() => write('d.json', { ...template, decisions: { ...template.decisions, openCreationMenus: { value: { creatorFeeBps: [100, 50], capBps: [100] }, approved: true } } }), /ascending/)
  assert.deepEqual(STAGE_DECISIONS['launch-config-init'], ['computeUnitPriceMicroLamports'])
  // The init stages start exactly where the legacy stack started on deploy day.
  assert.deepEqual({ fee: LAUNCH_CONFIG_START.launch_fee_lamports, ceiling: LAUNCH_CONFIG_START.max_creator_fee_bps, paused: LAUNCH_CONFIG_START.paused, bounds: [LAUNCH_CONFIG_START.min_virtual_quote, LAUNCH_CONFIG_START.max_virtual_quote] },
    { fee: '0', ceiling: 0, paused: true, bounds: ['1000000000', '1000000000'] })
  assert.ok(LOADER && SYSTEM)
})

test('collect_protocol_fees_native matches hook-lab\'s independent swap IDL exactly', { skip: INDEPENDENT_SKIP }, () => {
  const { stack, idls } = independentStack(), swap = JSON.parse(idls.swap), legacy = loadArtifacts()
  const abi = { ...legacy, idls: { ...legacy.idls, swap }, coders: { ...legacy.coders, swap: new BorshCoder(swap) } }
  const ix = instructionsFor(abi).collectProtocolFeesNative(stack.programs, stack.quoteMint, { cranker: key(), mint: key(), collector: key() })
  assert.deepEqual([...ix.data], swap.instructions.find(x => x.name === 'collect_protocol_fees_native').discriminator)
  assert.equal(new BorshCoder(swap).instruction.decode(ix.data).name, 'collect_protocol_fees_native')
  assert.equal(swap.instructions.some(x => x.name === 'collect_protocol_fees_sol'), false, 'no bridged collection on our stack')
})
