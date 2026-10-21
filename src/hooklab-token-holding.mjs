// Token create_holding ABI, independent of launch/owner artifact loaders.
import { createHash } from 'node:crypto'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
const pk = v => new PublicKey(v)
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds, pk(program))[0]
export const TOKEN_HOLDING_SIZE = 204
export function createHolding(programs, { payer, mint, owner }) {
  const token = programs.token
  return new TransactionInstruction({ programId: pk(token),
    data: createHash('sha256').update('global:create_holding').digest().subarray(0, 8),
    keys: [[payer,true,true],[mint,false,false],[owner,false,false],
      [pda(token,Buffer.from('holding'),pk(mint).toBuffer(),pk(owner).toBuffer()),false,true],
      ['11111111111111111111111111111111',false,false],
      [pda(token,Buffer.from('__event_authority')),false,false],[token,false,false]]
      .map(([address,isSigner,isWritable])=>({pubkey:pk(address),isSigner,isWritable})) })
}
