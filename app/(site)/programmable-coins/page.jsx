import Link from 'next/link'
import { ArrowRight, Blocks, Shield, SlidersHorizontal, Timer } from 'lucide-react'
import { AppHeader, Footer } from '../../components/ui'
import styles from './page.module.css'

export const metadata = {
  title: 'Programmable coins & Hook Lab — repo.ing',
  description: 'Explore creator-owned native coins on Hook Lab DEX. Compare launch-template ideas, understand custody risks, and try the preview-only coin planner. No live launch or trading.',
  alternates: { canonical: '/programmable-coins' },
}

export default function ProgrammableCoinsPage() {
  return <>
    <a className={styles.skip} href="#programmable-main">Skip to content</a>
    <AppHeader/>
    <main id="programmable-main" tabIndex={-1} className={styles.page}>
      <section className={styles.hero} aria-labelledby="programmable-title">
        <div>
          <p className={styles.eyebrow}>PROGRAMMABLE COINS / HOOK LAB</p>
          <p className={styles.badge}>Experimental devnet beta · Preview only</p>
          <h1 id="programmable-title">Your coin.<br/><span>Its own rules.</span></h1>
          <p className={styles.lead}>Explore coins with rules for holding, transferring, and exiting. repo.ing is the interface; Hook Lab DEX is the native programmable venue.</p>
          <p className={styles.definition}>This is your own coin, not a Hook Lab platform token. Hook Lab’s native standard is neither SPL nor Token-2022.</p>
          <div className={styles.actions}>
            <a className="button primary" href="#early-access">Explore early access <ArrowRight size={18} aria-hidden="true"/></a>
            <a className="button" href="#templates">See launch templates</a>
          </div>
          <p className={styles.fine}>No wallet or funds needed to explore.</p>
        </div>
        <aside className={styles.readiness} aria-labelledby="readiness-title">
          <p className={styles.eyebrow}>WHAT YOU CAN DO TODAY</p>
          <h2 id="readiness-title">A plan, not a launch.</h2>
          <ol>
            <li><span className={styles.step} aria-hidden="true">01</span><div><h3>Plan a coin <span>Available</span></h3><p>Compare lanes and supported recipe ideas. A draft creates no token or pool.</p></div></li>
            <li><span className={styles.step} aria-hidden="true">02</span><div><h3>Inspect devnet <span>Read-only</span></h3><p>Check program accounts after sign-in and network confirmation. An executable account is not proof of safety or launch readiness.</p></div></li>
            <li><span className={styles.step} aria-hidden="true">03</span><div><h3>Launch or trade <span>Unavailable</span></h3><p>The planner generates no executable transaction, quote, or simulation. Signing and sending are disabled.</p></div></li>
          </ol>
          <p className={styles.boundary}>Devnet deployment ≠ live executable support in repo.ing. Production launch and trading are not verified or enabled for this path.</p>
        </aside>
      </section>

      <section className={styles.section} aria-labelledby="capabilities-title">
        <div className={styles.sectionHeading}><p className={styles.eyebrow}>HOW IT WORKS</p><h2 id="capabilities-title">Rules live with the coin.</h2><p>A hook is program logic that runs when a supported token or pool action happens. These are protocol capabilities, not executable actions in the preview.</p></div>
        <div className={styles.columns}>
          <article className={styles.card}><Blocks aria-hidden="true"/><h3>Token-level behavior</h3><p>Native callbacks can respond to transfers, minting, and burning. Choose a supported recipe; the planner does not accept arbitrary hook code.</p></article>
          <article className={styles.card}><SlidersHorizontal aria-hidden="true"/><h3>Pool-level behavior</h3><p>Pool callbacks can apply rules around swaps and liquidity. Protocol fees and hook fees can stack; a template is not a cost estimate.</p></article>
          <article className={styles.card}><Shield aria-hidden="true"/><h3>A separate token standard</h3><p>Ordinary SPL wallets and DEXs do not automatically support these holdings. Hook Lab is not a Raydium or Meteora hook extension.</p></article>
        </div>
        <p className={styles.note}>Want a standard token instead? <Link href="/coins/new">Compare the Standard and Programmable lanes in the planner</Link>. Direct-coin planning is separate from repo.ing’s existing repository and model markets.</p>
      </section>

      <section id="templates" className={styles.section} aria-labelledby="templates-title">
        <div className={styles.sectionHeading}><p className={styles.eyebrow}>LAUNCH-TEMPLATE EXAMPLES</p><h2 id="templates-title">Start with a behavior to explore.</h2><p>Educational intent previews, not one-click launches. Example names below are fictional, not existing markets or investment recommendations.</p></div>
        <div className={styles.columns}>
          <article className={styles.template}><span className={styles.templateLabel}>01 / PLAIN</span><h3>Community coin</h3><p className={styles.example}>Example: Studio / STUDIO</p><p>A native coin without an optional token hook. Explore the basic launch structure before adding rules.</p><p className={styles.constraint}>No optional hook does not mean no fees: protocol pool rules still apply.</p></article>
          <article className={styles.template}><span className={styles.templateLabel}>02 / KIT</span><h3>Holding limits</h3><p className={styles.example}>Example: Gather / GATHER</p><p>Explore a max-wallet rule with Kit. The broader Kit design includes rewards and locks; those are not a promise of executable planner support.</p><p className={styles.constraint}>Parameters and combined fee bounds need validation. Kit and Half-Life cannot be combined as token hooks.</p></article>
          <article className={styles.template}><span className={styles.templateLabel}>03 / HALF-LIFE</span><h3>A declining exit fee</h3><p className={styles.example}>Example: Ember / EMBER</p><p>The fixed recipe starts at a 20% exit fee, halves every 6 hours, and reaches zero after 48 hours. It does not guarantee returns or price stability.</p><p className={styles.constraint}>Preparation, launch, and activation are separate steps, not one atomic transaction. Execution is unavailable here.</p></article>
        </div>
        <p className={styles.note}>One optional token hook per coin. Lottery, arbitrary hooks, companion execution, bridge deposits, and swaps are not enabled in this preview.</p>
      </section>

      <section className={styles.safety} aria-labelledby="safety-title">
        <div><p className={styles.eyebrow}>READ BEFORE EXPERIMENTING</p><h2 id="safety-title">Programmability adds responsibility.</h2><p>No production approval or independent audit is established for this path. Do not send real funds based on a preview or a successful devnet read.</p></div>
        <dl>
          <div><dt>Custody is not eliminated</dt><dd>repo.ing holds no user assets or signing keys in this preview. Hook Lab bridge programs custody underlying assets; native holdings represent claims, not ordinary SPL wallet balances. The beta records single-key upgrade, admin, and treasury control—a custody risk.</dd></div>
          <div><dt>Locked liquidity is not burned liquidity</dt><dd>The current launch program holds LP permanently in a program-controlled account. This is not a user-selected LP burn, and program upgrades remain a risk.</dd></div>
          <div><dt>Costs are unknown, not zero</dt><dd>Creator, protocol, and hook fees may combine, including elevated launch-period fees. Total debits, rent, minimum output, and quote expiry are unknown. Virtual curve reserves are not deposited SOL.</dd></div>
          <div><dt>A preview is not permission to transact</dt><dd>Live support needs reviewed SDK/config identities, decoded economics, exact-message simulation, signed acceptance, and explicit approval. Production also needs audit/remediation, custody controls, monitoring, and recovery.</dd></div>
        </dl>
      </section>

      <section id="early-access" className={styles.access} aria-labelledby="access-title">
        <div><p className={styles.eyebrow}>EARLY ACCESS / PLANNING ONLY</p><h2 id="access-title">Bring an idea.<br/>Leave with a draft.</h2><p>Explore the existing preview now. No deposit, wallet signature, or purchase is required.</p><Link className="button primary" href="/coins/new?lane=programmable">Create a Programmable Coin draft <ArrowRight size={18} aria-hidden="true"/></Link></div>
        <ol>
          <li><strong>Configure your Programmable Coin.</strong><p>This link opens the Programmable lane and resumes its device draft. Name your coin and select a supported recipe. Connecting your wallet shares an address only; signing remains disabled.</p></li>
          <li><strong>Review the terms.</strong><p>Read compatibility, fees, custody, and launch blockers. The device draft is saved locally; avoid confidential content.</p></li>
          <li><strong>Optionally keep an account draft.</strong><p>GitHub is optional for account backup and provenance, not required to configure or inspect devnet. Account drafts and audit records expire after 30 days.</p></li>
        </ol>
        <p className={styles.accessNote}><Timer size={18} aria-hidden="true"/><span>This is access to planning, not a beta admission or launch reservation. GitHub identifies draft ownership only—not wallet authority, access approval, or endorsement. No production launch date is promised.</span></p>
      </section>
      <p className={styles.source}>Scope reviewed October 15, 2026. <a href="https://github.com/new1direction/repo.ing/blob/main/docs/DIRECT_COINS.md">Read the public compatibility matrix and launch gates</a>. Capabilities must be re-verified before any execution is offered.</p>
    </main>
    <div className={styles.footer}><Footer/></div>
  </>
}
