// INTERNAL: call only inside the journal's already-open transaction, on the SAME
// PostgreSQL connection/database that owns wallet sessions. Lock journal first,
// then this session row. Logout/revoke only updates session rows, never journals.
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { hookAddress, HOOK_MAINNET_GENESIS } from './hooklab-execution-contract.mjs'
const fail=()=>Object.assign(Error('Wallet session unavailable, expired or changed'),{status:401})
export async function lockWalletPrincipal(db, sessionToken, expectedOrigin) {
  let origin
  try { origin=new URL(expectedOrigin);if(origin.protocol!=='https:'||origin.origin!==expectedOrigin)throw fail() }catch{throw fail()}
  if(typeof sessionToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)
    ||Buffer.from(sessionToken,'base64url').toString('base64url')!==sessionToken)throw fail()
  const digest=createHash('sha256').update(sessionToken).digest('hex')
  // FOR SHARE conflicts with expiry/revocation updates, not just key changes.
  const {rows:[row]}=await db.query(`select wallet,origin,audience,genesis_hash,expires_at,revoked_at
    from hook_lab_wallet_sessions where token_sha256=$1 for share`,[digest])
  const {rows:[clock]}=await db.query('select clock_timestamp() as now')
  if(!row||row.origin!==expectedOrigin||row.audience!=='general-launcher'||row.genesis_hash!==HOOK_MAINNET_GENESIS
    ||row.revoked_at!==null||!(row.expires_at instanceof Date)||row.expires_at<=clock.now||!hookAddress.safeParse(row.wallet).success||!PublicKey.isOnCurve(new PublicKey(row.wallet).toBuffer()))throw fail()
  return Object.freeze({kind:'wallet',wallet:row.wallet,origin:expectedOrigin,audience:'general-launcher',genesisHash:HOOK_MAINNET_GENESIS,
    expiresAt:row.expires_at.toISOString(),executionAuthorized:false,canLaunch:false,canSign:false,canSubmit:false})
}
