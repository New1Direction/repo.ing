import Link from 'next/link'
import { ArrowRight, ShieldCheck, Wallet } from 'lucide-react'
import { AppHeader, Footer } from '../components/ui'
import { GithubMark } from '../components/github-mark'

export const metadata = { title: 'About — repo.ing', description: 'Public GitHub repos can have a token, a market, and earnings from trading.' }

export default function About() {
  return <><AppHeader active="about"/><main className="section-wrap info-page">
    <section className="info-intro"><div className="eyebrow">ABOUT REPO.ING</div><h1>Open source projects.<br/><span>Open source markets.</span></h1><p>A public GitHub repo can have a token people can trade. Part of each trade fee is set aside for the repo.</p><div className="info-actions"><Link href="/explore" className="button primary">Explore markets <ArrowRight size={18}/></Link><Link href="/how-it-works" className="button outline">How it works</Link></div></section>
    <section className="info-card-grid" aria-label="What makes a repository market"><article className="info-card"><GithubMark size={23}/><h2>One repo. One token.</h2><p>Each public repo can have one token here. If the repo changes its name, its token stays the same.</p></article><article className="info-card"><Wallet size={23}/><h2>Launch and trade.</h2><p>Connect a Solana wallet to launch a token, buy it, or sell it. Trades happen through Meteora.</p></article><article className="info-card"><ShieldCheck size={23}/><h2>Fees for the repo.</h2><p>A GitHub repo admin can verify their access, sign with a payout wallet, and claim the repo’s trading fees.</p></article></section>
    <aside className="info-note"><strong>A token launch is not a repo endorsement.</strong><p>Anyone can launch a token for a public repo. The launcher cannot claim the repo’s fees unless they are a current GitHub admin.</p></aside>
  </main><Footer/></>
}
