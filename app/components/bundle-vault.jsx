import Link from 'next/link'
import { vaultHoldings } from '../../src/bundle-raise-chain.mjs'
import { formatSolDisplay, formatTokenAmount } from '../lib/format.mjs'
import { readBundleState } from '../lib/bundle-state.mjs'
import { chain, database } from '../lib/server.mjs'
import { BundleBackerPanel } from './bundle-raise'
import '../bundles.css'

// Token page of a market launched from a Bundle (markets.bundle_id, docs/BUNDLE_LAUNCH.md): its vault and where the partner fees
// went, read from the Bundle account and the vault's token accounts; then the connected wallet's claimable fees. The vault's
// own trades' fees are paid back to it first; the rest is split between the backers and repo.ing's treasury.

const sol = lamports => lamports === null || lamports === undefined ? '—' : `${formatSolDisplay(lamports)} SOL`

export function BundleVaultFallback() {
  return <div className="inner-card bundle-vault" aria-busy="true"><h3>Bundle vault</h3><p role="status" className="loading-placeholder">Reading the vault…</p></div>
}

async function readVault(market) {
  const pool = database()
  if (!pool) return null
  const connection = chain(), id = BigInt(market.bundleId)
  const state = await readBundleState({ pool, connection, id })
  // The bundle's mint must be this market's: anything else is shown as unavailable, never as this market's vault.
  if (!state?.chain || state.chain.mint !== market.mint) return null
  return { state, holdings: await vaultHoldings(connection, { id, mint: market.mint }) }
}

// Details → "Bundle vault" tab.
export async function BundleVault({ market }) {
  const read = await readVault(market).catch(error => { console.warn('bundle_vault_unavailable', { code: error?.code ?? error?.name ?? 'error' }); return null })
  if (!read) return <div id="bundle-vault" className="inner-card bundle-vault"><h3>Bundle vault</h3><p>The vault cannot be read right now. Try again shortly.</p></div>
  const { state, holdings } = read, chain = state.chain
  return <section id="bundle-vault" className="inner-card bundle-vault" aria-labelledby="bundle-vault-title">
    <div className="bundle-vault-heading"><h3 id="bundle-vault-title">Bundle vault</h3><Link href={`/bundle/${state.id}`}>Raise page →</Link></div>
    <p className="bundle-vault-lede">{state.backers ?? 'Its'} {state.backers === 1 ? 'backer' : 'backers'} raised {sol(chain.raised)} for this market. The raise bought its first
      tokens into this vault, which keeps its SOL for good; its trades stay within fixed on-chain limits.</p>
    <dl className="bundle-facts bundle-vault-facts">
      <div><dt>Vault tokens</dt><dd>{holdings.tokens === null ? '—' : `${formatTokenAmount(holdings.tokens, 6)} $${market.symbol}`}</dd></div>
      <div><dt>Vault SOL</dt><dd>{sol(holdings.sol)}</dd></div>
      <div><dt>Vault volume</dt><dd>{sol(chain.vaultVolume)}</dd></div>
      <div><dt>Routed to backers</dt><dd>{sol(chain.backerIncome)}</dd></div>
      <div><dt>Paid back to the vault</dt><dd>{sol(chain.vaultRebated)}</dd></div>
      <div><dt>To repo.ing</dt><dd>{sol(chain.treasuryIncome)}</dd></div>
    </dl>
    <p className="form-fineprint">Partner fees are routed by the program: the fees the vault&apos;s own trades generated go back to it first, then {chain.backerBps / 100}% of the rest
      to the backers and the remainder to repo.ing. Builder fees are unchanged.</p>
    <BundleBackerPanel initial={state}/>
  </section>
}
