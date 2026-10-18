// Owner-driver unit tests: approvals, key loading, one-send journal, message comparison,
// preview decoding and commitment computation. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import BN from 'bn.js'
import { Keypair, PublicKey } from '@solana/web3.js'
import { loadConfig, assertExecutable, roleAddresses, unapproved, APPROVAL_FLAG_STAGES } from '../src/hooklab-owner-driver/config.mjs'
import { parseKeyArgs, loadSigners } from '../src/hooklab-owner-driver/keys.mjs'
import { openJournal } from '../src/hooklab-owner-driver/journal.mjs'
import { compileReviewed, canonicalWithoutBlockhash } from '../src/hooklab-owner-driver/message.mjs'
import { addressBook, decodeMessage, fieldDiff, renderPreview } from '../src/hooklab-owner-driver/preview.mjs'
import * as ix from '../src/hooklab-owner-driver/instructions.mjs'
import { nextState } from '../src/hooklab-owner-driver/stages/common.mjs'
import { canaryCommitment } from '../src/hooklab-canary-policy.mjs'
import { binding } from '../src/hooklab-owner-driver/artifacts.mjs'
import { makeReaders, verifyGenesis, redact } from '../src/hooklab-owner-driver/rpc.mjs'
import { execute, awaitFinal, EXPIRY_MARGIN_BLOCKS } from '../src/hooklab-owner-driver/execute.mjs'
import { parseArgs } from '../src/hooklab-owner-driver/cli.mjs'
import { PROGRAMS, QUOTE_MINT, MAINNET_ROLES, MAINNET_GENESIS, derivedAddresses } from '../src/hooklab-owner-driver/pins.mjs'
import { localConfig, syntheticRoles } from './fixtures/hooklab-owner-local.mjs'

const template = new URL('../hooklab-owner.config.json', import.meta.url)
const scratch = () => mkdtempSync(path.join(tmpdir(), 'hooklab-owner-unit-'))
const write = (dir, name, value) => { const file = path.join(dir, name); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file }
const d = derivedAddresses()
const govState = (program, config, revision = 0) => ({ genesis: [...new PublicKey(MAINNET_GENESIS).toBuffer()], program: new PublicKey(program), config: new PublicKey(config),
  roles: { upgrade: new PublicKey(MAINNET_ROLES.upgrade), admin: new PublicKey(MAINNET_ROLES.admin), treasury: new PublicKey(MAINNET_ROLES.treasury), guardian: new PublicKey(MAINNET_ROLES.guardian) },
  revision: new BN(revision), gates: { creation: true, trading: false }, config_digest: Array(32).fill(3), custody_digest: Array(32).fill(4), pending_admin: null })

test('committed config template is unapproved, mainnet-pinned and has the reviewed decision values', () => {
  const config = loadConfig(template)
  assert.equal(config.network, 'mainnet-beta')
  assert.ok(Object.values(config.decisions).every(x => x.approved === false))
  const v = Object.fromEntries(Object.entries(config.decisions).map(([k, x]) => [k, x.value]))
  assert.deepEqual([v.creatorFeeBps, v.maxCreatorFeeBps, v.maxRulesFeeBps, v.launchProtocolShareBps, v.protocolFeeBps, v.capBps, v.selectedConfig], [100, 200, 200, 2500, 0, 200, null])
  assert.deepEqual([v.fund.creatorLamports, v.fund.adminLamports, v.fund.treasuryLamports], ['50000000', '50000000', '1000000'])
  assert.deepEqual(v.canaryBuy, { amountInRaw: '1000200', slippageBps: 50, maxPriceImpactBps: 1000 })
  for (const stage of ['launch-config', 'swap-config', 'grant', 'gate-finalize', 'canary-buy']) assert.throws(() => assertExecutable(config, stage), /not approved|not chosen/)
  assert.throws(() => assertExecutable(config, 'canary-prepare'), /not chosen: selectedConfig/)
  assert.deepEqual(roleAddresses(config).admin, MAINNET_ROLES.admin)
})
test('approval refusals: per-decision approval and the explicit approval-flag stages', () => {
  const dir = scratch()
  try {
    const raw = JSON.parse(readFileSync(template, 'utf8'))
    raw.decisions.maxCreatorFeeBps.approved = true; raw.decisions.computeUnitPriceMicroLamports.approved = true
    const config = loadConfig(write(dir, 'c.json', raw))
    assert.deepEqual(unapproved(config, 'launch-config'), ['maxRulesFeeBps'])
    raw.decisions.maxRulesFeeBps.approved = true
    assert.doesNotThrow(() => assertExecutable(loadConfig(write(dir, 'c2.json', raw)), 'launch-config'))
    assert.deepEqual([...APPROVAL_FLAG_STAGES].sort(), ['canary-buy', 'canary-gates-open-creation', 'canary-sell', 'fund', 'gate-finalize', 'open-launches', 'open-trading', 'trade-table'])
    raw.roles = { admin: MAINNET_ROLES.guardian }
    assert.throws(() => loadConfig(write(dir, 'c3.json', raw)), /may not substitute pinned role/)
    const local = localConfig(syntheticRoles()); local.roles.admin = MAINNET_ROLES.admin
    assert.throws(() => roleAddresses(loadConfig(write(dir, 'c4.json', local))), /synthetic/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('execute refuses before any I/O without approvals, approval flags or a reviewed sha', async () => {
  const dir = scratch()
  try {
    const raw = JSON.parse(readFileSync(template, 'utf8'))
    const ctx = { config: loadConfig(write(dir, 'c.json', raw)), journal: openJournal(dir), root: dir, network: 'mainnet-beta', genesis: MAINNET_GENESIS }
    const sha = 'ab'.repeat(32)
    await assert.rejects(execute(ctx, 'status', { messageSha256: sha }), /cannot be executed/)
    await assert.rejects(execute(ctx, 'gate-finalize', { messageSha256: 'nothex' }), /64-hex/)
    await assert.rejects(execute(ctx, 'launch-config', { messageSha256: sha }), /not approved/)
    for (const name of Object.keys(raw.decisions)) raw.decisions[name].approved = true
    raw.decisions.capBps.value = 200; raw.decisions.selectedConfig.value = Keypair.generate().publicKey.toBase58()
    const approvedCtx = { ...ctx, config: loadConfig(write(dir, 'c2.json', raw)) }
    await assert.rejects(execute(approvedCtx, 'gate-finalize', { messageSha256: sha }), /requires --approved gate-finalize:abab/)
    await assert.rejects(execute(approvedCtx, 'gate-finalize', { messageSha256: sha, approved: [`gate-finalize:${'cd'.repeat(32)}`] }), /requires --approved/)
    await assert.rejects(execute(approvedCtx, 'gate-finalize', { messageSha256: sha, approved: [`gate-finalize:${sha}`] }), /No reviewed plan/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('key loading: ROLE=PATH parsing, exact required set, address match, read-once named pipe', async () => {
  assert.throws(() => parseKeyArgs(['admin']), /ROLE=PATH/)
  assert.throws(() => parseKeyArgs(['root=/x']), /Unknown key role/)
  assert.throws(() => parseKeyArgs(['admin=/a', 'admin=/b']), /Duplicate/)
  const dir = scratch()
  try {
    const admin = Keypair.generate(), payer = Keypair.generate(), other = Keypair.generate()
    const roles = { admin: admin.publicKey.toBase58(), payer: payer.publicKey.toBase58() }
    const adminFile = write(dir, 'admin.json', JSON.stringify([...admin.secretKey])), otherFile = write(dir, 'other.json', JSON.stringify([...other.secretKey]))
    assert.throws(() => loadSigners(parseKeyArgs([`admin=${adminFile}`]), roles, [roles.payer, roles.admin]), /Missing --key payer/)
    assert.throws(() => loadSigners(parseKeyArgs([`admin=${adminFile}`, `payer=${adminFile}`]), roles, [roles.admin]), /not required/)
    assert.throws(() => loadSigners(parseKeyArgs([`admin=${otherFile}`]), roles, [roles.admin]), /does not match the expected address/)
    assert.throws(() => loadSigners(parseKeyArgs([`admin=${write(dir, 'bad.json', '[1,2,3]')}`]), roles, [roles.admin]), /64-byte keypair/)
    const fifo = path.join(dir, 'admin.pipe'); execFileSync('mkfifo', [fifo])
    const writer = spawn('/bin/sh', ['-c', `cat "${adminFile}" > "${fifo}"`])
    const [signer] = loadSigners(parseKeyArgs([`admin=${fifo}`]), roles, [roles.admin])
    assert.equal(signer.publicKey.toBase58(), roles.admin)
    await new Promise(resolve => writer.on('exit', resolve))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('one-send journal: exclusive claim, persisted history, pending and last success', () => {
  const dir = scratch()
  try {
    const journal = openJournal(dir), sha = '12'.repeat(32)
    journal.claim({ stage: 'grant', messageSha256: sha, lastValidBlockHeight: 10 })
    assert.throws(() => journal.claim({ stage: 'grant', messageSha256: sha }), /already claimed/)
    assert.equal(journal.pending('grant').length, 1)
    journal.update(sha, { status: 'signed', signature: 'sig' }); journal.update(sha, { status: 'finalized-success', slot: 42, postconditions: 'failed' })
    assert.equal(journal.pending('grant').length, 0)
    assert.equal(journal.lastSuccess('grant'), null, 'unverified postconditions never count as success')
    journal.update(sha, { postconditions: 'verified' })
    assert.equal(journal.lastSuccess('grant').slot, 42)
    assert.deepEqual(journal.get(sha).history.map(h => h.status), ['signed', 'finalized-success', 'finalized-success'])
    assert.throws(() => journal.claim({ stage: 'x', messageSha256: '../etc' }), /sha256/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
function sample(blockhash, maxCreatorFeeBps = 100) {
  const gov = govState(PROGRAMS.launch, d.launchConfig)
  const args = { admin: new PublicKey(MAINNET_ROLES.admin), treasury: new PublicKey(MAINNET_ROLES.treasury), quote_mint: new PublicKey(QUOTE_MINT), launch_fee_lamports: new BN(0),
    lp_fee_bps: 0, max_creator_fee_bps: maxCreatorFeeBps, sniper_window_secs: new BN(0), sniper_start_bps: 0, curve_bps: 7500, supply: new BN('1000000000000000'), decimals: 6,
    min_virtual_quote: new BN(1000000000), max_virtual_quote: new BN(1000000000), paused: true,
    rule_bounds: { max_holder_fee_bps: 0, max_burn_bps: 0, max_rules_fee_bps: 100, min_max_wallet_bps: 1, max_max_wallet_bps: 1, max_creator_lock_secs: 0, max_early_window_secs: 0, max_early_lock_secs: 0 } }
  return compileReviewed({ operation: 'launch-config', genesisHash: MAINNET_GENESIS, profileSha256: 'aa'.repeat(32), payer: MAINNET_ROLES.payer,
    instructions: [...ix.budget(200000, '0'), ix.governedSetConfig(PROGRAMS, 'launch', MAINNET_ROLES.admin, ix.governanceCommitment('launch', gov), args)],
    blockhash, lastValidBlockHeight: 500, observedSlot: 100, observedAtMs: 1000, validUntilSlot: 250, units: 200000, microLamports: '0' })
}
test('refreshed-blockhash comparison accepts only blockhash changes', () => {
  const a = sample('11111111111111111111111111111112'), b = sample('So11111111111111111111111111111111111111112'), c = sample('So11111111111111111111111111111111111111112', 99)
  assert.notEqual(a.review.messageSha256, b.review.messageSha256)
  assert.ok(canonicalWithoutBlockhash(a.review.messageBase64).equals(canonicalWithoutBlockhash(b.review.messageBase64)))
  assert.ok(!canonicalWithoutBlockhash(b.review.messageBase64).equals(canonicalWithoutBlockhash(c.review.messageBase64)))
  assert.equal(a.review.requiredSigners.join(), [MAINNET_ROLES.payer, MAINNET_ROLES.admin].join())
  assert.equal(a.review.maxFeeLamports, '10000')
})
test('preview decodes the exact message with labeled accounts, args and field diffs', () => {
  const { review } = sample('11111111111111111111111111111112')
  const book = addressBook({ programs: PROGRAMS, quoteMint: QUOTE_MINT, roles: MAINNET_ROLES })
  const decoded = decodeMessage(review.messageBase64, { programs: PROGRAMS, book })
  assert.deepEqual(decoded.map(x => x.instruction), ['SetComputeUnitLimit', 'SetComputeUnitPrice', 'launch.governed_set_config'])
  assert.deepEqual(decoded[2].accounts.map(a => [a.name, a.label, a.signer, a.writable]), [['authority', 'admin', true, false], ['config', 'launchConfig', false, true], ['governance', 'launchGovernance', false, true]])
  assert.equal(decoded[2].args.args.max_creator_fee_bps, 100)
  assert.deepEqual(fieldDiff({ a: 0, r: { m: 0, k: 1 } }, { a: 100, r: { m: 100, k: 1 } }), [{ field: 'a', before: 0, after: 100 }, { field: 'r.m', before: 0, after: 100 }])
  const text = renderPreview({ stage: 'launch-config', network: 'mainnet-beta', genesisHash: MAINNET_GENESIS, observedSlot: 1, providers: ['p', 's'], messageSha256: review.messageSha256,
    blockhash: 'x', lastValidBlockHeight: 500, payer: review.payer, requiredSigners: review.requiredSigners, signerRoles: { [MAINNET_ROLES.payer]: 'payer', [MAINNET_ROLES.admin]: 'admin' },
    networkFeeLamports: '10000', wireBytes: 595, instructions: decoded, approvalFlag: true, sections: [{ title: 'diff', rows: ['max_creator_fee_bps: 0 -> 100'] }] })
  assert.match(text, /arg args\.rule_bounds\.max_rules_fee_bps = 100/)
  assert.match(text, /--approved launch-config:/)
  assert.match(text, /S- authority\s+DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5 \(admin\)/)
})
test('governance commitment matches the reused canary policy and advances revision', () => {
  const state = govState(PROGRAMS.swap, d.swapConfig, 5)
  assert.ok(ix.governanceCommitment('swap', state).equals(canaryCommitment(binding('swap'), state)))
  const next = nextState(state, { gates: { creation: false, trading: false } })
  assert.equal(next.revision.toString(), '6'); assert.equal(state.revision.toString(), '5')
  assert.notDeepEqual(ix.governanceCommitment('swap', next), ix.governanceCommitment('swap', state))
})
test('RPC policy: mainnet needs two remote HTTPS providers; local-test needs loopback and a non-mainnet genesis', async () => {
  assert.throws(() => makeReaders({ rpc: 'http://127.0.0.1:8899', rpc2: 'https://b.example', localTest: false }), /remote HTTPS/)
  assert.throws(() => makeReaders({ rpc: 'https://a.example', rpc2: 'https://a.example', localTest: false }), /distinct origins/)
  assert.throws(() => makeReaders({ rpc: 'https://a.example', rpc2: 'https://b.example', localTest: true }), /loopback/)
  assert.equal(makeReaders({ localTest: false }).length, 2)
  const fake = hash => [{ connection: { getGenesisHash: async () => hash } }, { connection: { getGenesisHash: async () => hash } }]
  await assert.rejects(verifyGenesis(fake('EBfFo2A7Zb2ZUY6bRVWmPGJJJ5Xwpt65YxzNBNkbeqx3'), { localTest: false }), /not mainnet-beta/)
  await assert.rejects(verifyGenesis(fake(MAINNET_GENESIS), { localTest: true }), /refuses the mainnet genesis/)
  assert.equal(await verifyGenesis(fake(MAINNET_GENESIS), { localTest: false }), MAINNET_GENESIS)
  await assert.rejects(verifyGenesis([{ connection: { getGenesisHash: async () => MAINNET_GENESIS } }, { connection: { getGenesisHash: async () => 'other' } }], { localTest: false }), /different genesis/)
})
test('CLI argument parsing refuses unknown flags and stages', () => {
  assert.equal(parseArgs(['status']).stage, 'status')
  const parsed = parseArgs(['execute', 'grant', '--message-sha256', 'ab', '--key', 'payer=/p', '--key', 'admin=/a'])
  assert.deepEqual(parsed.key, ['payer=/p', 'admin=/a'])
  assert.throws(() => parseArgs(['plan', 'grant', '--yes']), /Unsupported/)
  assert.throws(() => parseArgs(['plan', 'deploy']), /Unknown stage/)
  assert.throws(() => parseArgs(['sign', 'grant']), /usage/)
})

test('mainnet config pins the canary mint and grant creator and caps the priority price', () => {
  const dir = scratch()
  try {
    const raw = JSON.parse(readFileSync(template, 'utf8'))
    assert.throws(() => loadConfig(write(dir, 'a.json', { ...raw, decisions: { ...raw.decisions, canaryMint: { value: Keypair.generate().publicKey.toBase58(), approved: true } } })), /canary mint is pinned/)
    const grant = { ...raw.decisions.grant, value: { ...raw.decisions.grant.value, creator: MAINNET_ROLES.admin } }
    assert.throws(() => loadConfig(write(dir, 'b.json', { ...raw, decisions: { ...raw.decisions, grant } })), /grant creator is pinned/)
    assert.throws(() => loadConfig(write(dir, 'c.json', { ...raw, decisions: { ...raw.decisions, computeUnitPriceMicroLamports: { value: '50001', approved: true } } })), /50,000/)
    assert.equal(redact('https://rpc.example/v1?api-key=secret'), 'https://rpc.example/v1?<redacted>')
    assert.equal(redact('https://api.mainnet-beta.solana.com'), 'https://api.mainnet-beta.solana.com')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
const fakeReaders = ({ status, height = 1000, statusError = false }) => [0, 1].map(i => ({ connection: {
  getSignatureStatuses: async () => { if (statusError === true || statusError === i) throw Error('429 Too Many Requests'); return { value: [status] } },
  getBlockHeight: async () => height, getTransaction: async () => null } }))
test('finality: RPC errors never count as an expired, unlanded transaction', async () => {
  const sig = '1'.repeat(64)
  assert.equal((await awaitFinal({ readers: fakeReaders({ status: null, height: 10000, statusError: 1 }) }, sig, 100, '', 2)).status, 'pending')
  assert.equal((await awaitFinal({ readers: fakeReaders({ status: null, height: 100 + EXPIRY_MARGIN_BLOCKS }) }, sig, 100, '', 1)).status, 'pending')
  assert.equal((await awaitFinal({ readers: fakeReaders({ status: null, height: 101 + EXPIRY_MARGIN_BLOCKS }) }, sig, 100, '', 1)).status, 'expired-unlanded')
  assert.equal((await awaitFinal({ readers: fakeReaders({ status: { confirmationStatus: 'confirmed' }, height: 10000 }) }, sig, 100, '', 1)).status, 'pending')
})
test('one-send is keyed on the reviewed plan: a refreshed attempt blocks any second send of that plan', async () => {
  const dir = scratch()
  try {
    const raw = JSON.parse(readFileSync(template, 'utf8'))
    for (const name of Object.keys(raw.decisions)) raw.decisions[name].approved = true
    const ctx = { config: loadConfig(write(dir, 'c.json', raw)), journal: openJournal(path.join(dir, 'j')), root: path.join(dir, 'runs'), network: 'mainnet-beta', genesis: MAINNET_GENESIS }
    const { review } = sample('11111111111111111111111111111112'), R = review.messageSha256, runDir = path.join(ctx.root, 'launch-config-x')
    const { mkdirSync } = await import('node:fs'); mkdirSync(runDir, { recursive: true })
    write(runDir, 'plan.json', { stage: 'launch-config', network: 'mainnet-beta', genesisHash: MAINNET_GENESIS, messageSha256: R, messageBase64: review.messageBase64, review, pinned: {}, expect: {} })
    ctx.journal.claim({ stage: 'launch-config', messageSha256: 'ef'.repeat(32), reviewedMessageSha256: R, lastValidBlockHeight: 1 })
    ctx.journal.update('ef'.repeat(32), { status: 'finalized-success', signature: 'sig', slot: 9 })
    await assert.rejects(execute(ctx, 'launch-config', { messageSha256: R, log: () => {} }), /already used .*one-send refuses a resend/)
    const tampered = sample('So11111111111111111111111111111111111111112').review
    write(runDir, 'plan.json', { stage: 'launch-config', network: 'mainnet-beta', genesisHash: MAINNET_GENESIS, messageSha256: R, messageBase64: tampered.messageBase64, review, pinned: {}, expect: {} })
    await assert.rejects(execute(ctx, 'launch-config', { messageSha256: R, log: () => {} }), /tampered plan/)
    const release = ctx.journal.lock('grant')
    assert.throws(() => ctx.journal.lock('grant'), /refusing concurrent sends/)
    release(); ctx.journal.lock('grant')()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
