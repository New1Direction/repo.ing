// Read-only: prints live mint facts for tip allowlist review. Never signs or sends.
// Usage: SOLANA_RPC_URL=<mainnet rpc> node scripts/verify-tip-token.mjs <mint> [<mint> ...]
//        node scripts/verify-tip-token.mjs --allowlist   (re-verifies every allowlisted SPL/Token-2022 mint)
import { Connection } from '@solana/web3.js'
import { TIP_TOKENS, describeTipMint, isNativeTip } from '../src/tip-tokens.mjs'

const connection = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'finalized')
const args = process.argv.slice(2)
const mints = args[0] === '--allowlist' ? TIP_TOKENS.filter(t => !isNativeTip(t)).map(t => t.mint) : args
if (!mints.length) { console.error('Usage: node scripts/verify-tip-token.mjs <mint> [...] | --allowlist'); process.exit(2) }
let failed = false
for (const mint of mints) {
  try {
    const facts = await describeTipMint(connection, mint)
    const listed = TIP_TOKENS.find(t => t.mint === mint)
    const drift = listed && (listed.program !== facts.program || listed.decimals !== facts.decimals || (facts.symbol && listed.symbol !== facts.symbol))
    if (!facts.check.ok || drift) failed = true
    console.log(JSON.stringify({ ...facts, listed: Boolean(listed), drift: Boolean(drift) }))
  } catch (error) { failed = true; console.log(JSON.stringify({ mint, error: error.message })) }
}
process.exitCode = failed ? 1 : 0
