// Synthetic raw accounts only. NOT finalized chain evidence or custody-control proof.
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { CUSTODY_MEMBERS, CUSTODY_MULTISIG, MULTISIG_VAULT, SQUADS_PROGRAM } from '../src/custody-multisig.mjs'
const pk = x => new PublicKey(x).toBuffer()
const n = (v, size) => { const b = Buffer.alloc(size); size === 8 ? b.writeBigUInt64LE(BigInt(v)) : b.writeUIntLE(v, 0, size); return b }
const tag = name => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8)
const pda = seeds => PublicKey.findProgramAddressSync(seeds, new PublicKey(SQUADS_PROGRAM))
export function governanceFixture(plan, slot = 50) {
  const [, bump] = pda([Buffer.from('multisig'), Buffer.from('multisig'), pk(CUSTODY_MEMBERS[0])])
  const [, vaultBump] = pda([Buffer.from('multisig'), pk(CUSTODY_MULTISIG), Buffer.from('vault'), n(0, 1)])
  const account = (address, name, bytes) => ({ address, owner: SQUADS_PROGRAM, executable: false, data: Buffer.concat([tag(name), ...bytes]) })
  return { slot, commitment: 'finalized', spendingLimitsComplete: true, spendingLimits: [],
    multisig: account(CUSTODY_MULTISIG, 'Multisig', [pk(CUSTODY_MEMBERS[0]), Buffer.alloc(32), n(2, 2), n(0, 4),
      n(plan.transactionIndex, 8), n(0, 8), n(1, 1), pk(MULTISIG_VAULT), n(bump, 1), n(3, 4),
      ...CUSTODY_MEMBERS.flatMap(k => [pk(k), n(7, 1)])]),
    transaction: account(plan.transaction, 'VaultTransaction', [pk(CUSTODY_MULTISIG), pk(plan.creator), n(plan.transactionIndex, 8),
      n(plan.transactionBump, 1), n(0, 1), n(vaultBump, 1), n(0, 4), plan.storedMessageBytes]),
    proposal: account(plan.proposal, 'Proposal', [pk(CUSTODY_MULTISIG), n(plan.transactionIndex, 8), n(5, 1), n(1, 8),
      n(plan.proposalBump, 1), n(2, 4), ...CUSTODY_MEMBERS.slice(0, 2).map(pk), n(0, 4), n(0, 4)]) }
}
