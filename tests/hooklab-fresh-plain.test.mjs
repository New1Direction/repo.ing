import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, cp, symlink, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import * as sdk from '@repo-ing/hooklab-guarded-candidate'
import { inspectFreshPlain, verifyFreshHltestPreview, recoverFreshHltest, FRESH_SOURCE_COMMIT, FRESH_MANIFEST_SHA256 } from '../src/hooklab-fresh-plain.mjs'

// Exact producer fixture, historical and unsigned; never executable as a live test.
const fixture = JSON.parse(await readFile(new URL('./fixtures/hooklab-fresh-hltest-unsigned.json', import.meta.url)))
const options = { confirmedNetwork: 'devnet' }

test('isolated SDK package preserves all pinned assets and excludes administration, trading, legacy and send APIs', async () => {
  assert.deepEqual(Object.keys(sdk).sort(), ['FRESH_DEVNET', 'NO_LAUNCH_RULES', 'decodeHolding', 'decodeLaunch', 'decodeLaunchConfig',
    'decodeMint', 'decodePool', 'decodeSwapConfig', 'freshCandidateManifest', 'freshLaunchAddresses', 'freshPlainLaunch',
    'freshRentInventory', 'launchEconomicsHash', 'launchV2Budget', 'poolEconomicsHash'].sort())
  const root = new URL('../vendor/hooklab-guarded-candidate/', import.meta.url)
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root)))
  assert.equal(provenance.revision, FRESH_SOURCE_COMMIT)
  assert.equal(provenance.manifestSha256, FRESH_MANIFEST_SHA256)
  for (const [path, hash] of Object.entries(provenance.files)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(path, root))).digest('hex'), hash, path)
    assert.equal(createHash('sha256').update(await readFile(new URL('../' + path, import.meta.resolve('@repo-ing/hooklab-guarded-candidate')))).digest('hex'), hash, `installed ${path}`)
  }
  assert.equal(sdk.freshCandidateManifest().executionEnabled, false)
  const directory = await mkdtemp(join(tmpdir(), 'fresh-plain-'))
  try {
    await cp(root, join(directory, 'package'), { recursive: true })
    await symlink(resolve('node_modules'), join(directory, 'node_modules'))
    const relocated = await import(pathToFileURL(join(directory, 'package/dist/index.mjs')))
    assert.equal(relocated.freshCandidateManifest().executionEnabled, false)
    await appendFile(join(directory, 'package/idl/fresh-devnet/bordrless_launch.json'), '\n')
    assert.throws(() => relocated.freshCandidateManifest(), /checksum mismatch/)
  } finally { await rm(directory, { force: true, recursive: true }) }
})

test('plain HLTEST reconstruction exactly matches the independently supplied 1112-byte producer message', () => {
  const result = verifyFreshHltestPreview(fixture, options)
  assert.equal(result.messageSha256, '458d2555fe2047f61eab3d4e855707ebe0a9ab2a17a8abbd00b6e18d28a0e34b')
  assert.equal(result.wireBytes, 1112)
  assert.deepEqual(result.message.staticAccountKeys.slice(0, 2).map(k => k.toBase58()), [fixture.creator, fixture.mint])
  assert.equal(result.budget.allInLamports, 32870000)
  assert.equal(result.canSign, false)
  assert.equal(result.canSubmit, false)
  assert.throws(() => verifyFreshHltestPreview(fixture, { confirmedNetwork: 'mainnet-beta' }), /devnet/)
})

test('acceptance refuses altered recipes, caps, identities, legacy hashes, display and instruction bytes', () => {
  const mutations = [
    p => { p.args.rules.holderFeeBuyBps = 1 },
    p => { p.args.creatorFeeBps = 1 },
    p => { p.args.virtualQuote = '1000000001' },
    p => { p.args.template = 'plain' },
    p => { p.creator = sdk.FRESH_DEVNET.authority.toBase58() },
    p => { [p.creator, p.mint] = [p.mint, p.creator] },
    p => { p.guard.expectedPoolEconomicsHash = '00'.repeat(32) },
    p => { p.guard.maxTotalDebitLamports = '32860001' },
    p => { p.guard.deadlineSlot = String(p.observedSlot) },
    p => { p.guard.deadlineSlot = String(p.observedSlot + 1501) },
    p => { p.accountsAndRents[0].rentLamports = '3520441' },
    p => { p.accountsAndRents[2].rentLamports = '1686559' },
    p => { p.budget.priorityFeeLamports = 1 },
    p => { p.bridgeDepositLamports = 1 },
    p => { p.reusedAlt.addresses.reverse() },
    p => { p.preview.messageBase64 = p.preview.messageBase64.slice(0, -4) + 'AAAA' },
    p => { p.preview.instructions[1].keys[2].address = p.creator },
    p => { p.preview.instructions.push(p.preview.instructions[0]) },
    p => { p.preview.signaturesRequired = 1 },
  ]
  for (const mutate of mutations) {
    const altered = structuredClone(fixture)
    mutate(altered)
    assert.throws(() => verifyFreshHltestPreview(altered, options), mutate.toString())
  }
})

test('inspection refuses wrong networks, missing fresh programs, missing evidence and RPC errors without leaking credentials', async () => {
  await assert.rejects(inspectFreshPlain({}, { confirmedNetwork: 'mainnet-beta' }), /devnet/)
  const wrong = await inspectFreshPlain({ getGenesisHash: async () => 'mainnet' }, options)
  assert.equal(wrong.readyForUnsignedSimulation, false)
  assert.ok(wrong.refusals.some(r => r.subject === 'network'))
  const absent = await inspectFreshPlain({ getGenesisHash: async () => sdk.freshCandidateManifest().genesisHash,
    getMultipleAccountsInfoAndContext: async addresses => ({ context: { slot: 511363101 }, value: addresses.map(() => null) }),
  }, options)
  assert.equal(absent.readyForUnsignedSimulation, false)
  for (const subject of ['deployment', 'swap', 'launch', 'swapConfig', 'launchConfig', 'quoteMint', 'alt']) {
    assert.ok(absent.refusals.some(r => r.subject === subject), subject)
  }
  const failure = await inspectFreshPlain({ getGenesisHash: async () => { throw new Error('https://sensitive.example/?token=do-not-print') } }, options)
  assert.ok(failure.refusals.some(r => r.subject === 'rpc'))
  assert.doesNotMatch(JSON.stringify(failure), /sensitive|token=|do-not-print/)
})

test('recovery requires exact receipt debits and real custom-token account state; an unresolved send never creates a replacement mint', async () => {
  const captured = JSON.parse(await readFile(new URL('./fixtures/hooklab-fresh-local-accounts.json', import.meta.url)))
  const { message } = verifyFreshHltestPreview(fixture, options)
  const loadedAddresses = { writable: [], readonly: [] }
  for (const lookup of message.addressTableLookups) {
    for (const i of lookup.writableIndexes) loadedAddresses.writable.push(new PublicKey(fixture.reusedAlt.addresses[i]))
    for (const i of lookup.readonlyIndexes) loadedAddresses.readonly.push(new PublicKey(fixture.reusedAlt.addresses[i]))
  }
  const keys = message.getAccountKeys({ accountKeysFromLookups: loadedAddresses })
  const addresses = Array.from({ length: keys.length }, (_, i) => keys.get(i).toBase58())
  // Synthetic receipt: no actual signatures or devnet execution are claimed by this fixture.
  const signature = bs58.encode(Buffer.alloc(64, 1))
  const receipt = { slot: fixture.observedSlot + 1, transaction: { message, signatures: [signature] }, meta: {
    err: null, fee: 10000, loadedAddresses, preBalances: addresses.map(a => a === fixture.creator ? 32870000 : 0),
    postBalances: addresses.map(a => a === sdk.FRESH_DEVNET.authority.toBase58() ? 10000000
      : Number(fixture.accountsAndRents.find(r => r.address === a)?.rentLamports ?? 0)),
  } }
  let returnedReceipt = receipt
  const connection = { getGenesisHash: async () => sdk.freshCandidateManifest().genesisHash,
    getTransaction: async () => returnedReceipt,
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: receipt.slot }, value: keys.map(k => {
      const account = captured.accounts[k.toBase58()]
      return { ...account, owner: new PublicKey(account.owner), data: Buffer.from(account.data[0], 'base64') }
    }) }),
  }
  const recovered = await recoverFreshHltest(connection, fixture, signature, options)
  assert.equal(recovered.status, 'finalized')
  assert.equal(recovered.mint, fixture.mint)
  assert.equal(recovered.mintState.symbol, 'HLTEST')
  assert.equal(recovered.mintState.mintAuthority, null)
  assert.deepEqual(recovered.holdings, { launchReserve: '250000000000000', launchQuote: '0', baseVault: '750000000000000', quoteVault: '0', launchLp: '0' })
  assert.equal(recovered.actualDebitLamports, '32870000')
  assert.equal(recovered.canSubmit, false)
  returnedReceipt = null
  assert.equal((await recoverFreshHltest(connection, fixture, signature, options)).status, 'unresolved')
  returnedReceipt = receipt
  receipt.meta.fee++
  await assert.rejects(recoverFreshHltest(connection, fixture, signature, options), /Receipt debit/)
  receipt.meta.fee--
  const mint = captured.accounts[fixture.mint]
  const owner = mint.owner
  mint.owner = sdk.FRESH_DEVNET.launch.toBase58()
  await assert.rejects(recoverFreshHltest(connection, fixture, signature, options), /ownership/)
  mint.owner = owner
  const holding = captured.accounts[sdk.freshCandidateManifest().callbackAndAcceptancePdas.baseVault]
  const data = Buffer.from(holding.data[0], 'base64')
  // Holding layout: discriminator(8), version+bump(2), mint(32), owner(32), amount(u64).
  data.writeBigUInt64LE(1n, 74)
  holding.data[0] = data.toString('base64')
  await assert.rejects(recoverFreshHltest(connection, fixture, signature, options), /Holdings changed/)
})
