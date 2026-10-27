// Hook admin handover to the custody vault (owner, 2026-10-26): DVdd nominates the vault on both governances, then the
// vault accepts through the 2-of-3 multisig. The vault transaction may carry only these AcceptAdmin instructions:
// governance_action { expected: Some(commitment), action: AcceptAdmin } on our own stack's launch or swap program,
// accounts [authority = vault (the only signer), config, governance]. Layout: hook-lab IDL governance_action, Action tag 4.
// Later governed changes (Config) go through the vault the same way.
import { PublicKey, TransactionInstruction } from '@solana/web3.js'

export const HOOK_GOVERNANCE_PROGRAMS = Object.freeze({
  launch: '9zzzPsLUsuu1XoGZ4TsHbghyXUPqXnHeJUpPRY7P5ZWu', swap: '72tDzM3mhFsYU1qecrLpScv1Bud6XaszkQtB4YVjJh9s' })
const GOVERNANCE_ACTION = Buffer.from([198, 163, 115, 123, 66, 135, 211, 193])
const ACCEPT_ADMIN = 4
const check = (ok, message) => { if (!ok) throw Error(message) }

export function acceptAdminInstruction({ programId, authority, config, governance, expected }) {
  check(Buffer.from(expected).length === 32, 'expected commitment must be 32 bytes')
  return new TransactionInstruction({ programId: new PublicKey(programId),
    keys: [{ pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(config), isSigner: false, isWritable: true }, { pubkey: new PublicKey(governance), isSigner: false, isWritable: true }],
    data: Buffer.concat([GOVERNANCE_ACTION, Buffer.from([1]), Buffer.from(expected), Buffer.from([ACCEPT_ADMIN])]) })
}

// Each governed instruction: the Hook launch or swap program, accounts [authority = vault (the only signer), config,
// governance].
function assertVaultGoverned(ix, vault) {
  check(new Set(Object.values(HOOK_GOVERNANCE_PROGRAMS)).has(ix.programId.toBase58()),
    `instruction program ${ix.programId.toBase58()} is not the Hook launch or swap program`)
  check(ix.keys.length === 3 && ix.keys[0].pubkey.toBase58() === new PublicKey(vault).toBase58(), 'the authority must be the vault')
  check(ix.keys[0].isSigner && !ix.keys[1].isSigner && !ix.keys[2].isSigner, 'only the vault may be a signer')
}

// Refuses anything but one or two AcceptAdmin instructions the vault signs alone.
export function assertHookAdminAccept(instructions, vault) {
  check(instructions.length >= 1 && instructions.length <= 2, 'the handover carries one to two AcceptAdmin instructions')
  for (const ix of instructions) {
    assertVaultGoverned(ix, vault)
    const data = Buffer.from(ix.data)
    check(data.subarray(0, 8).equals(GOVERNANCE_ACTION), 'instruction is not governance_action')
    check(data.length === 42 && data[8] === 1 && data[41] === ACCEPT_ADMIN, 'instruction is not AcceptAdmin with an expected commitment')
  }
}

// A vault Config change (owner-approved file, decoded and diffed by the builder before approval): only governed_set_config,
// which cannot move funds, change the admin or unpause (the program keeps admin and paused out of it).
const GOVERNED_SET_CONFIG = Buffer.from([31, 41, 21, 144, 249, 132, 134, 137])
export function assertHookGovernedConfig(instructions, vault) {
  check(instructions.length >= 1 && instructions.length <= 2, 'a Config change carries one to two governed_set_config instructions')
  for (const ix of instructions) {
    assertVaultGoverned(ix, vault)
    check(Buffer.from(ix.data).subarray(0, 8).equals(GOVERNED_SET_CONFIG), 'instruction is not governed_set_config')
  }
}
