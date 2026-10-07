import bs58 from 'bs58'
import BN from 'bn.js'
import { Connection, PublicKey } from '@solana/web3.js'
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'

// CP-AMM's claim_position_fee event as the RPC returns its self-CPI inner instruction (base58 data), and a finalized receipt
// carrying such events, for settlement tests (src/platform-fees.mjs settlePlatformClaim). No RPC is touched.
const program = new CpAmm(new Connection('http://127.0.0.1:1'))._program
const spec = program.idl.events.find(event => /^[eE]vtClaimPositionFee$/.test(event.name))
export function claimPositionFeeEvent({ pool, position = PublicKey.default, owner, feeA = 0n, feeB }) {
  return bs58.encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), Buffer.from(spec.discriminator),
    program.coder.types.encode(spec.name, { pool, position, owner, feeAClaimed: new BN(String(feeA)), feeBClaimed: new BN(String(feeB)) })]))
}
// keys/pre/post: the transaction's accounts and lamports (CP-AMM is appended); events: claimPositionFeeEvent results.
export function dammClaimReceipt({ keys, pre, post, fee = 5000, events = [] }) {
  const accountKeys = [...keys, CP_AMM_PROGRAM_ID]
  return { meta: { err: null, fee, preBalances: [...pre, 1], postBalances: [...post, 1],
    innerInstructions: [{ index: 0, instructions: events.map(data => ({ programIdIndex: accountKeys.length - 1, accounts: [], data })) }] },
    transaction: { message: { accountKeys } } }
}
