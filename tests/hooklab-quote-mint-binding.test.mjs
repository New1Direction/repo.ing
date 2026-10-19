// The bridged-SOL quote mint changes `supply` on every wrap and unwrap anyone makes through the public bridge. The
// production pin must accept exactly that change and nothing else: authorities, hook program, decimals, identity,
// owner, layout and allocation stay byte-identical to the reviewed snapshot.
// Fixture: mainnet A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i as pinned at slot 458598273 (sha 263d71ee…).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { BorshCoder } from '@anchor-lang/core'
import { PublicKey } from '@solana/web3.js'
import { productionAccountBindingMatches, productionDossierSchema } from '../src/hooklab-production-observer.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const idlBytes = readFileSync(new URL('../vendor/hooklab-production-candidate/idl/bordrless_token.json', import.meta.url))
const coder = new BorshCoder(JSON.parse(idlBytes)), discriminator = Buffer.from(JSON.parse(idlBytes).accounts.find(a => a.name === 'Mint').discriminator)
const pinned = Buffer.from(readFileSync(new URL('./fixtures/hooklab-quote-mint-mainnet.b64', import.meta.url), 'utf8'), 'base64')
const TOKEN = '2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22', MINT = 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i'
const pin = { role: 'quote-mint', address: MINT, owner: TOKEN, executable: false, dataSha256: sha(pinned),
  binding: 'mint-supply-v1', approvedDataBase64: pinned.toString('base64'), idlSha256: sha(idlBytes) }
const dossier = { schema: 'repoing/production-observation/2', programs: [{ role: 'token', address: TOKEN }] }
const account = bytes => ({ address: MINT, owner: TOKEN, executable: false, dataBase64: bytes.toString('base64') })
// Re-encode the mint with some fields changed, keeping the account's allocation.
const edited = patch => {
  const value = { ...coder.accounts.decode('Mint', pinned), ...patch }
  const body = Buffer.concat([discriminator, coder.types.encode('Mint', value)])
  return Buffer.concat([body, Buffer.alloc(pinned.length - body.length)])
}
const BN = coder.accounts.decode('Mint', pinned).supply.constructor
const matches = (bytes, p = pin, d = dossier) => productionAccountBindingMatches(p, account(bytes), d)

test('the reviewed snapshot is the real pinned mainnet mint', () => {
  assert.equal(pin.dataSha256, '263d71ee238222883020a393b5c752f8e03f28ca2276c856e037cb8ac9d28f65')
  assert.equal(coder.accounts.decode('Mint', pinned).supply.toString(), '17373498827')
  assert.ok(matches(pinned))
})

test('legitimate wraps and unwraps (supply up or down, to zero or max) keep the binding', () => {
  for (const supply of ['17254616542', '17373498828', '0', '18446744073709551615', '1'])
    assert.ok(matches(edited({ supply: new BN(supply) })), `supply ${supply}`)
})

test('any security-relevant change is refused', () => {
  const other = new PublicKey('11111111111111111111111111111112')
  for (const [label, patch] of Object.entries({
    decimals: { decimals: 6 }, version: { version: 2 }, 'max supply': { max_supply: new BN(1) },
    'mint authority': { mint_authority: other }, 'freeze authority': { freeze_authority: other }, 'hook authority': { hook_authority: other },
    'metadata authority': { metadata_authority: other }, 'hook program': { hook_program: other }, 'hook flags': { hook_flags: 1 },
    name: { name: 'Bordrless SOL2' }, symbol: { symbol: 'S0L' }, uri: { uri: 'https://evil.invalid' }, creator: { creator: other },
    'created at': { created_at: new BN(1) }, 'signer bump': { hook_signer_bump: 7 },
  })) assert.equal(matches(edited({ ...patch, supply: new BN('17254616542') })), false, label)
  const tail = Buffer.from(pinned); tail[pinned.length - 1] = 1
  assert.equal(matches(tail), false, 'bytes in the zero padding')
  const disc = Buffer.from(pinned); disc[0] ^= 1
  assert.equal(matches(disc), false, 'account discriminator')
  assert.equal(matches(Buffer.concat([pinned, Buffer.from([0])])), false, 'allocation grows')
  assert.equal(matches(pinned.subarray(0, pinned.length - 1)), false, 'allocation shrinks')
  assert.equal(productionAccountBindingMatches(pin, { ...account(pinned), owner: other.toBase58() }, dossier), false, 'owner program')
  assert.equal(productionAccountBindingMatches(pin, { ...account(pinned), executable: true }, dossier), false, 'executable')
  assert.equal(productionAccountBindingMatches(pin, { ...account(pinned), address: other.toBase58() }, dossier), false, 'address')
})

test('the binding itself cannot be bent', () => {
  const supply = edited({ supply: new BN('1') })
  for (const [label, patch] of Object.entries({ 'wrong role': { role: 'launch-config' }, 'wrong idl': { idlSha256: '0'.repeat(64) },
    'snapshot not the reviewed bytes': { approvedDataBase64: supply.toString('base64') }, 'unknown binding': { binding: 'mint-any-v1' },
    'owner is not the token program': { owner: '11111111111111111111111111111112' } }))
    assert.equal(matches(supply, { ...pin, ...patch }), false, label)
  assert.equal(matches(supply, pin, { ...dossier, schema: 'repoing/production-observation/1' }), false, 'schema 1 dossiers keep exact bytes')
  assert.equal(matches(supply, pin, { ...dossier, programs: [] }), false, 'no token program pinned')
  const exact = { ...pin }; delete exact.binding; delete exact.approvedDataBase64; delete exact.idlSha256
  assert.ok(matches(pinned, exact), 'exact pins still work'); assert.equal(matches(supply, exact), false, 'exact pins still refuse drift')
})

test('the production dossier schema accepts the binding only in its strict shape', () => {
  const accountPinShape = schema => productionDossierSchema.options[1].shape.accounts.element.safeParse(schema)
  assert.ok(accountPinShape(pin).success)
  assert.equal(accountPinShape({ ...pin, extra: true }).success, false)
  assert.equal(accountPinShape({ ...pin, idlSha256: undefined }).success, false)
})

test('rebinding the production bundle changes only the quote-mint pin and its dossier hash', async () => {
  const { rebindQuoteMint } = await import('../scripts/hooklab-production-bundle-rebind.mjs')
  const before = JSON.parse(readFileSync(new URL('../config/hooklab-production-bundle.json', import.meta.url), 'utf8'))
  const after = rebindQuoteMint(before, pinned)
  const committed = JSON.parse(readFileSync(new URL('../config/hooklab-production-bundle-2.json', import.meta.url), 'utf8'))
  assert.deepEqual(after, committed, 'the committed bundle 2 is exactly this transform')
  assert.equal(after.config.dossierSha256, sha(after.dossierJson))
  const [a, b] = [JSON.parse(before.dossierJson), JSON.parse(after.dossierJson)]
  assert.deepEqual({ ...b, accounts: null }, { ...a, accounts: null })
  for (const [x, y] of a.accounts.map((pinBefore, i) => [pinBefore, b.accounts[i]]))
    if (x.role === 'quote-mint') assert.deepEqual(y, { ...x, binding: 'mint-supply-v1', approvedDataBase64: pinned.toString('base64'), idlSha256: sha(idlBytes) })
    else assert.deepEqual(y, x)
  assert.deepEqual({ ...after, config: { ...after.config, dossierSha256: null }, dossierJson: null }, { ...before, config: { ...before.config, dossierSha256: null }, dossierJson: null })
  const tampered = Buffer.from(pinned); tampered[30] ^= 1
  assert.throws(() => rebindQuoteMint(before, tampered), /do not hash to the reviewed pin/)
  assert.throws(() => rebindQuoteMint(after, pinned), /already has binding/)
})
