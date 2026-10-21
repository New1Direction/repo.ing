import Link from 'next/link'
import { Info, LockKeyhole } from 'lucide-react'

export function HooksIntro({ title, children, art = 'launch-market', action, eyebrow = 'HOOKS' }) {
  return <header className="hooks-intro"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1><p>{children}</p></div>
    <div className="hooks-intro-action"><img src={`/launch-icons/${art}.webp`} width={72} height={72} alt=""/>{action}</div>
  </header>
}

export function HooksNav({ active }) {
  return <nav className="hooks-nav" aria-label="Hooks navigation">{[['markets', '/hooks', 'Hooks'], ['launch', '/hooks/launch-review', 'Launch a coin'], ['trade', '/hooks/trade', 'Buy & sell'], ['blocks', '/hooks/blocks', 'Blocks'], ['mine', '/hooks/mine', 'My coins']].map(([key, href, label]) =>
    <Link key={key} href={href} aria-current={active === key ? 'page' : undefined}>{label}</Link>)}</nav>
}

export function HooksUnavailable({ title = 'Execution unavailable', children }) {
  return <div className="hooks-notice"><LockKeyhole size={20} aria-hidden="true"/><div><strong>{title}</strong><p>{children || 'Create and keep a recipe draft. Launching, signing and public trading are not enabled.'}</p></div></div>
}

export function HooksRisk({ native = false }) {
  return <div className="hooks-notice"><Info size={20} aria-hidden="true"/><p>Hooks coins run on repo.ing’s Hook Lab programs instead of the standard Solana token program, so most wallets and explorers won’t show them yet. {native ? 'Trades use SOL straight from your wallet.' : 'Trades use SOL moved into Hook Lab, kept separate from the SOL in your wallet.'} repo.ing can still upgrade the launch and trading programs, and like any new coin, a hooks coin can lose all its value.</p></div>
}

// Presentation only: keep the server's refusal intact for diagnosis, without
// asking a creator to interpret internal codes or assume a transaction failed.
export function HooksOperationError({ error }) {
  if (!error) return null
  const technical = /[A-Z]{2,}_[A-Z_]+|[a-z][A-Z]|SHA-?256|exact-message|registry|timelock|finalized-|outcome-unknown|\bRPC\b/.test(error)
  const summary = /requires verified release approval/i.test(error)
    ? 'Custom-hook launches are not approved for this release yet. Nothing will be signed.'
    : technical ? 'This step stopped because its safety checks could not be completed. If you already approved a transaction, wait for its result before trying again.' : error
  return <div><p className="inline-error" role="alert">{summary}</p>
    {summary !== error && <details><summary>Technical details</summary><p style={{ overflowWrap: 'anywhere' }}>{error}</p></details>}
  </div>
}
