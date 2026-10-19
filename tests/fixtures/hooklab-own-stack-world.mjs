// Our own stack, set up from nothing in one isolated in-memory SBF bank: the relocated stack's four programs at their own
// IDs (tests/fixtures/hooklab-own-stack.mjs), its quote marker as hook-lab's deploy leaves it, then the owner's first-time
// setup sent as real signed transactions (launch and swap init_config and init_governance with the approved economics,
// the gate made immutable, native launches on, open creation on with the owner's menus) and the two frozen shared tables.
// Then the production bundle for that stack is collected from the bank by the real collector. Customers are fresh
// wallets that sign their own transactions; only the RPC framing around the bank is synthetic. No owner agent, no admin
// co-signature, no keys outside this process.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { isolatedSvm, localTestEnvironment, syntheticGenesis } from './hooklab-canary.mjs'
import { INDEPENDENT_SKIP, independentStack, ownStack } from './hooklab-own-stack.mjs'
import { parseStack, stackElfLengths } from '../../src/hooklab-stack.mjs'
import { collectStackProductionBundle, stackProductionArtifacts } from '../../src/hooklab-production-stack-bundle.mjs'
import { productionProfileJson } from '../../src/hooklab-production-operator-bundle.mjs'
import { governedSetNativeLaunches } from '../../src/hooklab-native-launch.mjs'
import { governedSetOpenCreation } from '../../src/hooklab-open-creation.mjs'
import { openLaunchTableAddresses } from '../../src/hooklab-max-wallet-launch.mjs'
import { sharedTradeAddresses } from '../../src/hooklab-owner-launch-tables.mjs'
import { collectInclusiveMaxWalletPreparationReview } from '../../src/hooklab-inclusive-max-wallet-preparation-collector.mjs'
import { collectOpenLaunchReview } from '../../src/hooklab-max-wallet-launch-collector.mjs'
import { collectOpenLaunchSettlement } from '../../src/hooklab-max-wallet-launch-settlement.mjs'
import { launchDebitLimits } from '../../src/hooklab-production-bootstrap.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest()
const hex = bytes => sha(bytes).toString('hex')
const pk = value => new PublicKey(value), kb = value => pk(value).toBuffer()
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(program))[0].toBase58()
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111', SYSTEM = '11111111111111111111111111111111', ALT = 'AddressLookupTab1e1111111111111111111111111'
const DOMAIN = 'repo.ing atomic canary isolated SVM tests v1 '
const ROLES = ['creator', 'admin', 'upgrade', 'guardian', 'treasury', 'mint', 'config', 'outsider', 'table', 'buyer']
// The runner's deterministic synthetic signers (tests/fixtures/hooklab-canary-svm.py).
export const runnerKey = role => Keypair.fromSeed(sha(DOMAIN + role))
export const OWNER_MENUS = Object.freeze({ creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] })
// The owner's confirmed creation fee (0.02 SOL) and the USD-priced opening-price bounds the website quotes within.
export const CREATION_FEE_LAMPORTS = 20000000n
export const VIRTUAL_QUOTE_BOUNDS = Object.freeze(['1000000000', '112500000000'])
// The bank's clock (tests/fixtures/hooklab-canary-svm.py): every receipt is in its one finalized block.
const BLOCK_TIME = 1800000000
const NAMES = { launch: 'bordrless_launch', swap: 'bordrless_swap', gate: 'hook_max_wallet', token: 'bordrless_token' }
const tokenIdl = JSON.parse(readFileSync(new URL('../../vendor/hooklab-production-candidate/idl/bordrless_token.json', import.meta.url)))
const tokenCoder = new BorshCoder(tokenIdl)

function defaults(idl, type) {
  if (typeof type === 'string') return type === 'pubkey' ? pk(SYSTEM) : type === 'bool' ? false : type === 'string' ? '' : ['u64', 'u128', 'i64', 'i128'].includes(type) ? new BN(0) : 0
  if (type.option) return null
  if (type.array) return Array.from({ length: type.array[1] }, () => defaults(idl, type.array[0]))
  if (type.defined) return Object.fromEntries(idl.types.find(t => t.name === type.defined.name).type.fields.map(f => [f.name, defaults(idl, f.type)]))
  throw Error('Unsupported synthetic codec')
}
// The marker mint as the owner's create_mint leaves it (hook-lab independent-stack design, section 3): a Mint of our token
// program, decimals 9, name "Native SOL quote marker", symbol SOL, no URI, max supply 0, and no authority of any kind.
function markerMint(stack) {
  const value = { ...defaults(tokenIdl, { defined: { name: 'Mint' } }), version: 1, decimals: 9, name: 'Native SOL quote marker', symbol: 'SOL' }
  const body = tokenCoder.types.encode('Mint', value), out = Buffer.alloc(519)
  Buffer.from(tokenIdl.accounts.find(a => a.name === 'Mint').discriminator).copy(out); body.copy(out, 8)
  return { address: stack.quoteMint, owner: stack.programs.token, dataBase64: out.toString('base64'), lamports: '10000000', executable: false }
}
// A frozen, active lookup table holding exactly these addresses.
export function frozenTable(address, addresses) {
  const data = Buffer.alloc(56 + 32 * addresses.length)
  data.writeUInt32LE(1); data.writeBigUInt64LE(0xffffffffffffffffn, 4); data.writeBigUInt64LE(50n, 12)
  addresses.forEach((a, i) => kb(a).copy(data, 56 + i * 32))
  return { address, owner: ALT, dataBase64: data.toString('base64'), lamports: '100000000', executable: false, sha256: hex(data) }
}

// build: 'independent' (hook-lab's own build at its placeholder IDs, the default when present) or 'relocated' (the reviewed
// ELFs moved to fresh IDs; seed picks them).
// rentPerByte: the bank's rent rate, lamports per byte of an account (128 bytes of overhead included in its size), as
// mainnet's 5,080 today; the bank's own default otherwise.
export async function ownStackWorld({ build = INDEPENDENT_SKIP ? 'relocated' : 'independent', seed = 'a', rentPerByte = null } = {}) {
  const env = localTestEnvironment(), saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  const roles = Object.fromEntries(ROLES.map(role => [role, runnerKey(role).publicKey.toBase58()]))
  const draft = build === 'independent' ? independentStack({ upgradeAuthority: roles.upgrade }) : ownStack({ seed })
  const stack = parseStack({ ...draft.stack, upgradeAuthority: roles.upgrade }), { elfs, idls } = draft
  const P = stack.programs, dir = mkdtempSync(path.join(tmpdir(), 'hooks-own-stack-'))
  for (const [role, bytes] of Object.entries(elfs)) writeFileSync(path.join(dir, `${NAMES[role]}.so`), bytes)
  const svm = isolatedSvm()
  const close = () => { svm.close(); rmSync(dir, { recursive: true, force: true }); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
  try {
    const init = await svm.call('init', { scope: 'isolated-canary-svm/1', programs: Object.entries(NAMES).map(([role, name]) => ({ address: P[role], path: path.join(dir, `${name}.so`), sha256: hex(elfs[role]) })) })
    if (JSON.stringify(init.roles) !== JSON.stringify(roles)) throw Error('Runner roles differ')
    const perByte = rentPerByte === null ? 6960 : (await svm.call('rent', { lamportsPerByte: rentPerByte })).lamportsPerByte
    // Upgradeable programs at the stack's IDs, all upgradeable by the stack's authority (the gate is finalized below).
    const accounts = []
    for (const role of ['launch', 'swap', 'gate', 'token']) {
      const programData = pda(LOADER, kb(P[role])), header = Buffer.alloc(45)
      header.writeUInt32LE(3); header.writeBigUInt64LE(1n, 4); header[12] = 1; kb(roles.upgrade).copy(header, 13)
      const program = Buffer.alloc(36); program.writeUInt32LE(2); kb(programData).copy(program, 4)
      accounts.push({ address: programData, account: { owner: LOADER, dataBase64: Buffer.concat([header, elfs[role]]).toString('base64'), lamports: '10000000000', executable: false } },
        { address: P[role], account: { owner: LOADER, dataBase64: program.toString('base64'), lamports: '10000000000', executable: true } })
    }
    for (const role of ['admin', 'upgrade', 'guardian', 'treasury', 'outsider', 'creator', 'buyer']) accounts.push({ address: roles[role], account: { owner: SYSTEM, dataBase64: '', lamports: '100000000000', executable: false } })
    accounts.push({ address: stack.quoteMint, account: markerMint(stack) })
    await svm.call('set', { accounts: accounts.sort((x, y) => Number(x.account.executable) - Number(y.account.executable)) })

    const executed = new Map(), coders = Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, new BorshCoder(JSON.parse(idls[role]))]))
    const record = result => { if (result.historyPresent) executed.set(result.signature, result); return result }
    const blockhash = async () => (await svm.call('get', { addresses: [] })).blockhash
    const message = async (payer, instructions) => Buffer.from(new TransactionMessage({ payerKey: pk(payer), recentBlockhash: await blockhash(), instructions }).compileToV0Message().serialize()).toString('base64')
    // Runner-signed (the owner's synthetic roles) or wallet-signed (a customer's own keys) transactions.
    const send = async messageBase64 => record(await svm.call('send', { messageBase64 }))
    const submit = async wireBase64 => record(await svm.call('submit', { wireBase64 }))
    const signAndSubmit = async (messageBase64, keypairs) => {
      const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(messageBase64, 'base64')))
      tx.sign(keypairs); return submit(Buffer.from(tx.serialize()).toString('base64'))
    }
    const must = async (label, pending) => { const result = await pending; if (result.error) throw Error(`${label}: ${result.error} ${(result.logs ?? []).slice(-6).join(' | ')}`); return result }
    const get = async addresses => new Map((await svm.call('get', { addresses })).accounts.map(r => [r.address, r.account]))
    const data = async address => Buffer.from((await get([address])).get(address)?.dataBase64 ?? '', 'base64')
    const fund = (address, lamports = '20000000000') => svm.call('set', { accounts: [{ address, account: { owner: SYSTEM, dataBase64: '', lamports, executable: false } }] })
    const ix = (role, name, args, values) => {
      const program = P[role], def = JSON.parse(idls[role]).instructions.find(x => x.name === name)
      const m = { program, system_program: SYSTEM, config: pda(program, 'config'), governance: pda(program, 'governance'), event_authority: pda(program, '__event_authority'),
        program_data: pda(LOADER, kb(program)), ...values }
      return new TransactionInstruction({ programId: pk(program), data: coders[role].instruction.encode(name, args),
        keys: def.accounts.map(k => ({ pubkey: pk(m[k.name] ?? k.address), isSigner: !!k.signer, isWritable: !!k.writable })) })
    }
    const governance = async role => coders[role].accounts.decode('Governance', await data(pda(P[role], 'governance'))).state
    const commitment = async role => sha(Buffer.concat([Buffer.from('hook-lab/governance-state/1\0'), coders[role].types.encode('State', await governance(role))]))

    // The owner's first-time setup (what the owner-driver stages send), each a real signed transaction. A mainnet build
    // initializes both configs paused; governance then owns the gates, and opening them unpauses creation and trading.
    const launchArgs = { admin: pk(roles.admin), treasury: pk(roles.treasury), quote_mint: pk(stack.quoteMint), launch_fee_lamports: new BN(CREATION_FEE_LAMPORTS.toString()), lp_fee_bps: 0,
      max_creator_fee_bps: 200, sniper_window_secs: new BN(0), sniper_start_bps: 0, curve_bps: 7500, supply: new BN('1000000000000000'), decimals: 6,
      min_virtual_quote: new BN(VIRTUAL_QUOTE_BOUNDS[0]), max_virtual_quote: new BN(VIRTUAL_QUOTE_BOUNDS[1]), paused: true,
      rule_bounds: { max_holder_fee_bps: 0, max_burn_bps: 0, max_rules_fee_bps: 200, min_max_wallet_bps: 1, max_max_wallet_bps: 9999, max_creator_lock_secs: 0, max_early_window_secs: 0, max_early_lock_secs: 0 } }
    const swapArgs = { admin: pk(roles.admin), protocol_fee_bps: 0, fee_collector: pk(roles.treasury), treasury: pk(roles.treasury), pool_creation_fee_lamports: new BN(0), paused: true, launch_protocol_share_bps: 2500 }
    const custody = [...sha('synthetic own-stack custody')]
    for (const [role, args] of [['launch', launchArgs], ['swap', swapArgs]]) {
      await must(`${role} init_config`, send(await message(roles.upgrade, [ix(role, 'init_config', { args }, { authority: roles.upgrade })])))
      await must(`${role} init_governance`, send(await message(roles.admin, [ix(role, 'init_governance', { args: { genesis: [...kb(syntheticGenesis)], guardian: pk(roles.guardian), custody_digest: custody } },
        { admin: roles.admin, payer: roles.admin })])))
    }
    for (const role of ['launch', 'swap']) await must(`${role} open gates`, send(await message(roles.admin, [ix(role, 'governance_action',
      { expected: [...await commitment(role)], action: { SetGates: [{ creation: false, trading: false }] } }, { authority: roles.admin })])))
    // The gate made immutable (loader SetAuthority without a new authority), as the owner's gate-finalize stage does.
    await must('gate finalize', send(await message(roles.upgrade, [new TransactionInstruction({ programId: pk(LOADER), data: Buffer.from([4, 0, 0, 0]),
      keys: [{ pubkey: pk(pda(LOADER, kb(P.gate))), isSigner: false, isWritable: true }, { pubkey: pk(roles.upgrade), isSigner: true, isWritable: false }] })])))
    await must('native launches on', send(await message(roles.admin, [governedSetNativeLaunches({ launchProgram: P.launch, admin: roles.admin, expected: await commitment('launch'), on: true })])))
    await must('open creation on', send(await message(roles.admin, [governedSetOpenCreation({ launchProgram: P.launch, admin: roles.admin, expected: await commitment('launch'), on: true, ...OWNER_MENUS })])))

    // The two frozen shared tables, at the owner's addresses, then our stack's production bundle read from the bank.
    const providers = ['local-a', 'local-b'], endpoints = [env.HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY, env.HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY]
    const transport = (alter = () => {}) => ({ getGenesisHash: async () => syntheticGenesis, getSlot: async () => 100, getBlockHeight: async () => 100,
      getMinimumBalanceForRentExemption: async size => (128 + size) * perByte,
      getMultipleAccountsInfoAndContext: async keys => { const s = await svm.call('get', { addresses: keys.map(k => k.toBase58()) })
        return { context: { slot: s.slot }, value: s.accounts.map(({ account: v }) => v ? { owner: pk(v.owner), executable: v.executable, lamports: Number(v.lamports), data: Buffer.from(v.dataBase64, 'base64') } : null) } },
      getLatestBlockhashAndContext: async () => ({ context: { slot: 100 }, value: { blockhash: await blockhash(), lastValidBlockHeight: 250 } }),
      getBlock: async slot => slot === 100 ? { blockhash: await blockhash(), previousBlockhash: roles.config, parentSlot: 99, blockHeight: 100, blockTime: null } : null,
      isBlockhashValid: async () => ({ context: { slot: 100 }, value: true }), getFeeForMessage: async m => ({ context: { slot: 100 }, value: 5000 * m.header.numRequiredSignatures }),
      // A transaction its wallet already signed is simulated exactly as given; an unsigned review, signed by the runner.
      simulateTransaction: async (tx, config) => { const signed = tx.signatures.length > 0 && tx.signatures.every(s => s.some(b => b !== 0)), addresses = config?.accounts?.addresses ?? []
        const r = await svm.call(signed ? 'simulate-signed' : 'simulate', signed ? { wireBase64: Buffer.from(tx.serialize()).toString('base64'), addresses } : { messageBase64: Buffer.from(tx.message.serialize()).toString('base64'), addresses })
        return { context: { slot: 100 }, value: { err: r.error, logs: r.logs, unitsConsumed: r.units, accounts: r.accounts?.map(v => v && { owner: v.owner, lamports: Number(v.lamports), executable: false, rentEpoch: 0, data: [v.dataBase64, 'base64'] }) ?? null } } },
      getTransaction: async signature => { const r = executed.get(signature); if (!r) return null; const signed = VersionedTransaction.deserialize(Buffer.from(r.wireBase64, 'base64'))
        const tx = { slot: r.slot, blockTime: BLOCK_TIME, transaction: { message: signed.message, signatures: signed.signatures.map(s => bs58.encode(s)) }, meta: { err: r.error, fee: r.fee, preBalances: [...r.preBalances], postBalances: [...r.postBalances],
          loadedAddresses: Object.fromEntries(Object.entries(r.loadedAddresses).map(([k, v]) => [k, v.map(pk)])), logMessages: [...r.logs],
          innerInstructions: r.innerInstructions.map(g => ({ index: g.index, instructions: g.instructions.map(({ dataBase64, ...i }) => ({ ...i, accounts: [...i.accounts], data: bs58.encode(Buffer.from(dataBase64, 'base64')) })) })) } }
        alter(tx); return tx },
      getBlockSignatures: async () => ({ blockhash: roles.table, previousBlockhash: roles.config, parentSlot: 99, blockHeight: 100, blockTime: BLOCK_TIME, signatures: [...executed.keys()] }) })
    const connections = alter => providers.map((provider, i) => ({ provider, connection: { rpcEndpoint: endpoints[i], ...transport(alter) } }))
    const trustDomains = providers.map((provider, i) => ({ provider, trustDomain: 'single-local-validator', origin: new URL(endpoints[i]).origin }))
    const configBytes = await data(pda(P.launch, 'config'))
    // The stack profile as the bundle derives it, for the two tables' inventories before the bundle exists.
    const draftEnvelope = { json: productionProfileJson(stackProductionArtifacts(stack, idls).base), elfLengths: stackElfLengths(stack),
      idls: Object.fromEntries(Object.entries(idls).map(([role, bytes]) => [role, bytes.toString('base64')])) }
    const launchTable = frozenTable(roles.table, openLaunchTableAddresses(draftEnvelope, configBytes))
    const tradeTable = frozenTable(Keypair.generate().publicKey.toBase58(), sharedTradeAddresses(JSON.parse(draftEnvelope.json)))
    await svm.call('set', { accounts: [launchTable, tradeTable].map(({ sha256, ...account }) => ({ address: account.address, account })) })
    // The bundle pins both governances exactly, so after a governed change (open creation, a pause) the owner collects it
    // again; recollect() does that, and bundle/bindings always name the current one.
    const collect = () => collectStackProductionBundle({ stack, idls, connections: connections(), trustDomains, lookupTable: tradeTable.address, launchTable: launchTable.address,
      reviewer: roles.admin, treasury: roles.treasury, approvalReference: 'LOCAL-OWN-STACK-SVM', network: { genesisHash: syntheticGenesis, local: true } })
    const current = { bundle: await collect() }
    const recollect = async () => { current.bundle = await collect(); return current.bundle }
    const lamports = async addresses => Object.fromEntries([...(await get(addresses))].map(([address, account]) => [address, BigInt(account?.lamports ?? 0)]))
    return { svm, stack, idls, roles, programs: P, get bundle() { return current.bundle }, get bindings() { const b = current.bundle; return { config: b.config, profile: b.profile, dossierJson: b.dossierJson } }, recollect, coders, connections, send, submit, signAndSubmit, must, message, get, data, fund, lamports, governance, commitment,
      launchTable, tradeTable, executed, close, ix, holdingOf: (mint, owner) => pda(P.token, 'holding', kb(mint), kb(owner)), runnerKey }
  } catch (error) { close(); throw error }
}

export const PREP_LIMITS = { maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: 196, reviewExpiresAtMs: 6000, maxRentLamports: '20000000', maxNetworkFeeLamports: '20000',
  maxTotalDebitLamports: '20020000', computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0' }
// The production bootstrap's launch bounds for this bundle's economics.
export const LAUNCH_LIMITS = { maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: 196, reviewExpiresAtMs: 6000, maxNetworkFeeLamports: '15000', computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0',
  ...launchDebitLimits({ launchFeeLamports: String(CREATION_FEE_LAMPORTS), poolCreationFeeLamports: '0' }, '15000') }
// One self-serve launch exactly as the website runs it, for a fresh wallet (or the given creator, e.g. a runner wallet
// whose later reviews the runner can simulate): prepare, launch, settle.
export async function openLaunch(w, { creatorFeeBps, capBps, name, symbol, virtualQuote, creator = Keypair.generate() }) {
  const mint = Keypair.generate(), selectedConfig = Keypair.generate(), signers = [creator, mint, selectedConfig]
  await w.fund(creator.publicKey.toBase58(), '2000000000')
  const profile = w.bindings.profile, G = w.programs.gate
  const prep = { schema: 'repoing/inclusive-max-wallet-preparation-request/1', policyKind: 'max-wallet', policyVersion: 2, creator: creator.publicKey.toBase58(),
    feePayer: creator.publicKey.toBase58(), mint: mint.publicKey.toBase58(), selectedConfig: selectedConfig.publicKey.toBase58(), capBps, label: symbol.toLowerCase(),
    creatorFeeBps, rules: 'none', hookFlags: 1, feeModel: 2, protocolShareBps: 2500 }
  const prepProfile = { json: profile.json, expectedSha256: profile.expectedSha256, providers: profile.providers, idls: { launch: profile.idls.launch, gate: profile.idls.gate },
    elfLengths: { launch: profile.elfLengths.launch, gate: profile.elfLengths.gate } }
  const prepared = await collectInclusiveMaxWalletPreparationReview({ profile: prepProfile, request: prep, connections: w.connections(), limits: PREP_LIMITS, clock: () => 1000 })
  const sign = review => signers.filter(k => review.requiredSigners.includes(k.publicKey.toBase58()))
  await w.must('preparation', w.signAndSubmit(prepared.plan.review.messageBase64, sign(prepared.plan.review)))
  const hashOf = async address => hex(await w.data(address))
  const preparation = { wallet: prep.creator, profileSha256: w.bindings.config.profileSha256, preparationIntentSha256: hex(JSON.stringify(prep)), preparedRequest: prep, executionSlot: 100,
    preparedAccountHashes: { policy: await hashOf(pda(G, 'policy-v2', mint.publicKey.toBuffer())), registry: await hashOf(pda(G, 'bordrless-hook-accounts', mint.publicKey.toBuffer())), selectedConfig: await hashOf(prep.selectedConfig) } }
  const { schema, ...prepFields } = prep
  const request = { ...prepFields, schema: 'repoing/open-launch-request/1', name, symbol, uri: '', virtualQuote }
  const collected = await collectOpenLaunchReview({ ...w.bindings, connections: w.connections(), preparation, request, limits: LAUNCH_LIMITS, clock: () => 1000 })
  return { creator, mint, request, collected, preparationFeeLamports: 5000 * prepared.plan.review.requiredSigners.length, async send() {
    const review = collected.plan.review, sent = await w.signAndSubmit(review.messageBase64, sign(review))
    return { sent, async settle() { return collectOpenLaunchSettlement({ ...w.bindings, connections: w.connections(), settlementContext: collected.settlementContext, review,
      signedTransactionBase64: sent.wireBase64, signature: sent.signature }) } }
  } }
}

