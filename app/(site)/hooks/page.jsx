import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { HooksIntro, HooksNav, HooksUnavailable, HooksRisk } from '../../components/hooks-ui'

export const metadata = { title: 'Hooks — repo.ing', description: 'Discover programmable coin recipes and keep your draft. Hook Lab launch and trading remain unavailable.' }

export default function HooksPage() {
  return <><HooksIntro title="Coins with their own rules." art="find-repo" action={<Link className="button primary" href="/hooks/templates">Create a coin draft <ArrowRight size={16}/></Link>}>
    Explore the rules. Build a recipe. Know what happens before you sign.
  </HooksIntro><HooksNav active="markets"/><HooksUnavailable/>
    <section className="hooks-card hooks-empty" aria-labelledby="hooks-market-title">
      <img src="/launch-icons/find-repo.webp" width={88} height={88} alt=""/>
      <h2 id="hooks-market-title">Live markets are not available yet</h2>
      <p>There is no verified public Hook Lab market feed here. Prices, charts and trades will appear only when supported data is available.</p>
      <Link className="button" href="/hooks/templates">Explore six recipe templates <ArrowRight size={16}/></Link>
      <p className="hooks-fine">No wallet or funds needed. Drafting does not create a token.</p>
    </section>
    <div className="hooks-explain"><div><h2>Read the rules first</h2><p>Burns, wallet restrictions and creator fees affect different parts of a trade. A template is not a quote or a safety guarantee.</p></div><Link href="/programmable-coins">Understand Hook Lab <ArrowRight size={16}/></Link></div><HooksRisk/>
  </>
}
