// The re-enable instruction encodes exactly the pinned IDL layout.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BorshCoder } from '@anchor-lang/core'
import { Keypair } from '@solana/web3.js'
import { setCreatorAuthorization, initCreatorAuthorization } from '../src/hooklab-owner-driver/instructions.mjs'
import { PROGRAMS, MAINNET_ROLES, authorizationAddress, derivedAddresses } from '../src/hooklab-owner-driver/pins.mjs'
const idl = JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/bordrless_launch.json', import.meta.url)))
const coder = new BorshCoder(idl)
test('set_creator_authorization re-enables with the exact args, accounts and signer', () => {
  const creator = Keypair.generate().publicKey.toBase58(), expected = Buffer.alloc(32, 0xab), d = derivedAddresses(PROGRAMS)
  const ix = setCreatorAuthorization(PROGRAMS, { admin: MAINNET_ROLES.admin, creator, expiresAtSlot: '458544906', maxLaunches: '2', expectedGovernance: expected })
  assert.equal(ix.programId.toBase58(), PROGRAMS.launch)
  const decoded = coder.instruction.decode(Buffer.from(ix.data))
  assert.equal(decoded.name, 'set_creator_authorization')
  assert.equal(decoded.data.args.enabled, true); assert.equal(decoded.data.args.expires_at_slot.toString(), '458544906'); assert.equal(decoded.data.args.max_launches.toString(), '2')
  assert.equal(Buffer.from(decoded.data.expected_governance).toString('hex'), expected.toString('hex'))
  assert.deepEqual(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [[MAINNET_ROLES.admin, true, false], [d.launchConfig, false, false], [d.launchGovernance, false, true], [authorizationAddress(creator, PROGRAMS.launch), false, true]])
  const init = coder.instruction.decode(Buffer.from(initCreatorAuthorization(PROGRAMS, { admin: MAINNET_ROLES.admin, payer: MAINNET_ROLES.payer, creator, expiresAtSlot: '1', maxLaunches: '1', expectedGovernance: expected }).data))
  assert.equal(init.name, 'init_creator_authorization'); assert.equal(init.data.creator.toBase58(), creator)
})
