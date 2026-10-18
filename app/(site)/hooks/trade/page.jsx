import { HookInclusiveTrade } from '../../../components/hooklab-inclusive-trade'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'
import { inclusiveTradeRuntime } from '../../../lib/hooklab-inclusive-trade-runtime.mjs'
import { executionGenesis, localAcceptanceNetwork } from '../../../../src/hooklab-local-acceptance.mjs'
import { HookLocalOperations } from '../../../components/hooklab-local-operations'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Buy or sell a max-wallet coin — repo.ing', robots: { index: false, follow: false } }
export default function InclusiveTradePage() {
  const initialBlockers = process.env.HOOK_INCLUSIVE_TRADING_ENABLED !== 'true' || process.env.HOOK_WALLET_IDENTITY_ENABLED !== 'true'
    ? [{ code: 'INCLUSIVE_TRADING_DISABLED', message: 'Trading awaits explicit deployment and fee approval.' }]
    : !inclusiveTradeRuntime() ? [{ code: 'INCLUSIVE_TRADE_RUNTIME_UNCONFIGURED', message: 'Exact approved program pins and trading settings are not installed.' }] : []
  return <main><HooksIntro title="Buy or sell a max-wallet coin.">Review exact server-verified amounts and fees, sign with your wallet, and follow the original transaction to its finalized receipt.</HooksIntro><HooksNav/>
    {localAcceptanceNetwork() && <p role="status" className="inner-card"><strong>LOCAL ACCEPTANCE · synthetic funds only.</strong> One isolated validator; two local proxies are not independent production evidence. Platform receives floor(gross creator fee / 4), creator receives the remainder. No platform surcharge. Production fee rate, cap and recipients remain unapproved.</p>}
    <HookInclusiveTrade genesisHash={executionGenesis()} initialBlockers={initialBlockers}/>
    {localAcceptanceNetwork() && <HookLocalOperations genesisHash={executionGenesis()}/>}
    <HooksRisk/></main>
}
