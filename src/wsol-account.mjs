import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'

// Browser-safe (web3.js only). A wallet's wrapped-SOL ATA is its referral payout account.
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112')
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

export const wsolAta = owner => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), NATIVE_MINT.toBuffer()], ATA_PROGRAM)[0]

// createAssociatedTokenAccountIdempotent(owner = wallet, mint = WSOL): never touches funds beyond its rent. The payer is the
// wallet itself, or repo.ing's partner wallet for a free setup (src/referral-sponsorship.mjs); the wallet never signs then.
export function createWsolAtaInstruction(wallet, payer = wallet) {
  return new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: wsolAta(wallet), isSigner: false, isWritable: true },
    { pubkey: wallet, isSigner: false, isWritable: false }, { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }] })
}

export function isCreateWsolAta(ix, wallet, payer = wallet) {
  const k = ix.keys.map(key => key.pubkey)
  return ix.programId.equals(ATA_PROGRAM) && ix.data.length === 1 && ix.data[0] === 1 && k.length === 6 &&
    k[0].equals(payer) && k[1].equals(wsolAta(wallet)) && k[2].equals(wallet) && k[3].equals(NATIVE_MINT) &&
    k[4].equals(SystemProgram.programId) && k[5].equals(TOKEN_PROGRAM)
}

// The payout setup transaction may hold exactly one instruction: the wallet creating its own WSOL ATA.
export function assertWsolSetupTransaction(tx, wallet) {
  if (!tx.feePayer?.equals(wallet) || tx.instructions.length !== 1 || !isCreateWsolAta(tx.instructions[0], wallet)) {
    throw Error('Referral payout setup transaction is not the expected account creation')
  }
}
