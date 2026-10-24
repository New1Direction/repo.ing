import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { deriveDammV1MigrationMetadataAddress, deriveDbcEventAuthority, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { NATIVE_MINT } from '@solana/spl-token'
import { DBC_PROGRAM_ID } from './launch-fee-config.mjs'
import { CUSTODY_MEMBERS, MULTISIG_VAULT } from './custody-multisig.mjs'
import { matchesReviewedLaunch } from './launch-wallet-assertions.mjs'

// Finalized at slot 460643065. Applies only to new ordinary launches; never reinterpret historical creator ownership.
export const RECOVERED_LAUNCH_CONFIG = 'Fy2bhQbNPxLPShPxEuTnYzusWgSpSVEgCZ9cbby32TU7'
export const RECOVERED_LAUNCH_CONFIG_SHA256 = 'f0214c67a087ff43c60574ee706de6f407248d91afa6780c22f6a2656461c896'
// Never provision an exposed key, a vault member, or the funded recovery payer as the application's online co-signer.
const FORBIDDEN_BOOTSTRAP = new Set([...CUSTODY_MEMBERS, MULTISIG_VAULT, 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1',
  'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3', '3eCFwDiKetHe9pg1zNEkTohUECu2vtsZDRMZ3jeR4g5o'])
const CREATE_SPL_POOL = Buffer.from([140, 85, 215, 176, 102, 54, 104, 79])
const TRANSFER_CREATOR = Buffer.from([20, 7, 169, 33, 58, 147, 166, 33])
const key = value => new PublicKey(value)
const tagged = (ix, tag) => ix.programId.equals(DBC_PROGRAM_ID) && ix.data.subarray(0, 8).equals(tag)
const requireHandoff = condition => { if (!condition) throw Error('Recovered launch custody handoff is missing or inconsistent') }

export function assertLaunchBootstrapSigner(creator) {
  if (FORBIDDEN_BOOTSTRAP.has(key(creator).toBase58())) throw Error('Recovered launch requires a separate safe bootstrap signer')
}

// SDK 1.5.13 transferPoolCreator account order, including DAMM v1 migration metadata. Unlike that SDK helper, building this
// instruction does not first fetch the pool: it must follow creation atomically, before any lasting online creator rights exist.
export function launchCustodyHandoff({ pool, creator }) {
  assertLaunchBootstrapSigner(creator)
  const addresses = [pool, RECOVERED_LAUNCH_CONFIG, creator, MULTISIG_VAULT, deriveDbcEventAuthority(), DBC_PROGRAM_ID,
    deriveDammV1MigrationMetadataAddress(key(pool))]
  return new TransactionInstruction({ programId: DBC_PROGRAM_ID, data: TRANSFER_CREATOR,
    keys: addresses.map((address, i) => ({ pubkey: key(address), isWritable: i === 0, isSigner: i === 2 })) })
}

// Shared signing/receipt boundary. The final pool state alone cannot prove an atomic handoff: a later transaction could have
// changed its creator. Require the exact handoff in this creation message, after all financial instructions. Only the same
// constrained trailing wallet assertions accepted by launch signing may follow. Returns the initial co-signer, not the vault.
export function readLaunchCustodyHandoff(tx, { mint, pool, launcher, creator = null }) {
  requireHandoff(tx instanceof Transaction && tx.feePayer?.equals(key(launcher)))
  requireHandoff(deriveDbcPoolAddress(NATIVE_MINT, key(mint), key(RECOVERED_LAUNCH_CONFIG)).equals(key(pool)))
  const creates = tx.instructions.filter(ix => tagged(ix, CREATE_SPL_POOL))
  const handoffs = tx.instructions.filter(ix => tagged(ix, TRANSFER_CREATOR))
  requireHandoff(creates.length === 1 && handoffs.length === 1)
  const [create] = creates, [handoff] = handoffs
  const initial = create.keys[2]?.pubkey
  requireHandoff(initial && !initial.equals(key(MULTISIG_VAULT)) && (!creator || initial.equals(key(creator))))
  for (const [index, expected] of [[0, RECOVERED_LAUNCH_CONFIG], [3, mint], [5, pool], [10, launcher]]) {
    requireHandoff(create.keys[index]?.pubkey.equals(key(expected)))
  }
  const expected = launchCustodyHandoff({ pool, creator: initial })
  requireHandoff(handoff.data.equals(expected.data) && handoff.keys.length === expected.keys.length &&
    handoff.keys.every((meta, i) => meta.pubkey.equals(expected.keys[i].pubkey)))
  const at = tx.instructions.indexOf(handoff)
  requireHandoff(tx.instructions.indexOf(create) < at)
  const prefix = new Transaction({ feePayer: tx.feePayer, recentBlockhash: tx.recentBlockhash }).add(...tx.instructions.slice(0, at + 1))
  requireHandoff(matchesReviewedLaunch(Buffer.from(prefix.serializeMessage()), tx))
  const message = tx.compileMessage(), signers = message.accountKeys.slice(0, message.header.numRequiredSignatures)
  requireHandoff([initial, key(mint), key(launcher)].every(k => signers.some(signer => signer.equals(k))))
  return initial
}
