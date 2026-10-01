import { BadgeCheck, Coins, GitCommitHorizontal, GitMerge, Newspaper, Rocket, Star, Users } from 'lucide-react'

const ICONS = { release: Rocket, merge: GitMerge, commits: GitCommitHorizontal, stars: Star, hn: Newspaper, verified: BadgeCheck, paid: Coins, devs: Users }

// One icon per Dev Pulse event kind; the colour comes from the .pulse-kind-* class on a parent.
export function PulseIcon({ kind, size = 16 }) {
  const Icon = ICONS[kind] ?? GitCommitHorizontal
  return <Icon size={size} aria-hidden="true" strokeWidth={2.2}/>
}
