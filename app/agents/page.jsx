import Link from 'next/link'
import { AppHeader, Footer } from '../components/ui'
import { LaunchTools } from '../components/launch-tools'
import { agentLaunchConfigured } from '../../src/agent-launch-draft.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Launch tools · repo.ing', description: 'Launch from an agent, a GitHub README, or your browser. Review and approve with your wallet.' }
export default function Agents() {
  return <><AppHeader active="launch"/><main className="section-wrap agent-tools-page"><Link href="/launch" className="back-link">← Back to launch</Link>
    <div className="page-intro"><h1>Your repo. One review away.</h1><p>Start where you work. Your wallet approves the launch.</p></div>
    <LaunchTools enabled={agentLaunchConfigured()}/>
  </main><Footer/></>
}
