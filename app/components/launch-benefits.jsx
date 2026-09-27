import Link from 'next/link'
import { GitBranch, Rocket, Coins, ArrowRight } from 'lucide-react'

export function LaunchBenefits({ discoveryEnabled = false, compact = false }) {
  return <section className={`launch-benefits${compact ? ' compact' : ''}`} aria-label="Why launch a repository?">
    <ol>
      <li><span className="launch-benefit-icon"><GitBranch size={20} aria-hidden="true"/></span><div><strong>Find a great repo</strong><p>Any public GitHub project. You don’t have to own it.</p></div></li>
      <li><span className="launch-benefit-icon"><Rocket size={20} aria-hidden="true"/></span><div><strong>Launch its market</strong><p>Review the token and SOL cost. Approve with your wallet.</p></div></li>
      <li><span className="launch-benefit-icon"><Coins size={20} aria-hidden="true"/></span><div><strong>{discoveryEnabled ? 'Earn discovery fees' : 'Help fund its builders'}</strong><p>{discoveryEnabled ? 'Your launch wallet earns a share when people trade. Builders earn too.' : 'Trading fees accrue for the verified repository owner.'}</p></div></li>
    </ol>
    {discoveryEnabled && <div className="launch-reward-terms"><span><strong>50% of repo.ing’s curve fee share.</strong> Ends at graduation, 30 days, or 2.5 SOL earned—whichever comes first. Rewards depend on trading.</span><Link href="/how-it-works#discovery">Reward details <ArrowRight size={14} aria-hidden="true"/></Link></div>}
  </section>
}
