import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { productionReadiness } from '../../../../src/hooklab-production-observer.mjs'
import { firstCreatorPacket } from '../../../../src/hooklab-plain.mjs'
import { HookLabPlainPreparation, HookLabProductionAccount } from '../../../components/hooklab-plain-preparation'
import '../../../direct-coins.css'

export const metadata = { title: 'Hook Lab production readiness · repo.ing', robots: { index: false } }
export const dynamic = 'force-dynamic'

export default function ProductionReadinessPage() {
  const readiness = productionReadiness()
  return <><AppHeader active="launch"/><main className="direct-coins">
    <Link className="back-link" href="/coins/hltest">← Frozen HLTEST devnet evidence</Link>
    <header className="coin-intro"><span className="badge">Hook Lab DEX · production unavailable</span>
      <h1>Production verification</h1>
      <p>repo.ing is the consumer interface for Hook Lab DEX. No production profile is adopted here. Wallet connection is available for preparation only; transactions and funds remain disabled.</p>
    </header>
    <HookLabPlainPreparation packet={firstCreatorPacket()}/>
    <HookLabProductionAccount/>
    <section className="coin-entry-points" aria-labelledby="production-status"><div>
      <h2 id="production-status">Mainnet evidence unavailable</h2>
      <p>Network: Solana mainnet-beta (intended, not verified). Program identities, deployment slots, pause state and balances are unverified. No active creator or retained production receipt is bound.</p>
      <ul>{readiness.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>
      <p>The proposed production profile has no config or upgrade timelock. Hook Lab’s existing three-day hook-code delay is a different control, not a custody guarantee.</p>
    </div></section>
    <section className="coin-entry-points" aria-labelledby="production-capabilities"><div>
      <h2 id="production-capabilities">What is available</h2>
      <dl className="coin-terms">
        <div><dt>Production verification and recovery</dt>
        <dd>Unavailable until a reviewed dossier and independent finalized observations are bound. Reloading preserves this status; it never retries a transaction.</dd></div>
        <div><dt>Plain creation</dt>
        <dd>Disabled here. The proposed production contract allows plain rules only, zero creator fee and no Kit accounts. Creator quotas are lifetime cumulative with exclusive-slot expiry; legacy and direct pool creation are rejected.</dd></div>
        <div><dt>Swaps and liquidity</dt>
        <dd>Disabled here. Swap minimum output does not provide all guarded-creation protections. Trading pause also blocks LP withdrawal. Curve pools reject add/remove liquidity; graduation LP belongs to the launch PDA with no withdrawal instruction.</dd></div>
        <div><dt>Fees and receipts</dt>
        <dd>No live quote, simulation, wallet review or production receipt is available. Native network and priority fees are separate from token input, program fees and account rent.</dd></div>
        <div><dt>Kit and other Hooks</dt>
        <dd>Not supported by this consumer. No Raydium or Meteora hook compatibility is implied.</dd></div>
      </dl>
    </div></section>
    <section className="coin-entry-points" aria-labelledby="production-recovery"><div>
      <h2 id="production-recovery">Recovery never means relaunch</h2>
      <p>Retain the original signature, exact message and mint. An unavailable or disagreeing provider is not proof of failure. A finalized transaction is not a verified token operation until account and economic postconditions match.</p>
      <p>No automatic retry, replacement mint, historical-pin fallback or expiry-based deletion is enabled. Do not enter private keys or seed phrases.</p>
    </div></section>
  </main><Footer/></>
}
