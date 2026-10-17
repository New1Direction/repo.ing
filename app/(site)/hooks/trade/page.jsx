import { HookInclusiveTrade } from '../../../components/hooklab-inclusive-trade'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'
import { inclusiveTradeRuntime } from '../../../lib/hooklab-inclusive-trade-runtime.mjs'
import { HOOK_MAINNET_GENESIS } from '../../../../src/hooklab-execution-contract.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Buy or sell a max-wallet coin — repo.ing', robots: { index: false, follow: false } }
export default function InclusiveTradePage() {
  const initialBlockers = process.env.HOOK_INCLUSIVE_TRADING_ENABLED !== 'true' || process.env.HOOK_WALLET_IDENTITY_ENABLED !== 'true'
    ? [{ code: 'INCLUSIVE_TRADING_DISABLED', message: 'Trading awaits explicit deployment and fee approval.' }]
    : !inclusiveTradeRuntime() ? [{ code: 'INCLUSIVE_TRADE_RUNTIME_UNCONFIGURED', message: 'Exact approved program pins and trading settings are not installed.' }] : []
  return <main><HooksIntro title="Buy or sell a max-wallet coin.">Review exact server-verified amounts and fees, sign with your wallet, and follow the original transaction to its finalized receipt.</HooksIntro><HooksNav/><HookInclusiveTrade genesisHash={HOOK_MAINNET_GENESIS} initialBlockers={initialBlockers}/><HooksRisk/></main>
}
