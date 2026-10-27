import { HooksLaunchPage } from '../../../components/hooks-launch-page'
import { openLaunchesEnabled } from '../../../../src/hooklab-open-creation.mjs'
export const dynamic = 'force-dynamic'
export async function generateMetadata() {
  const description = openLaunchesEnabled(process.env)
    ? 'Launch a coin with a wallet cap and a creator fee. Add an image and links, check the costs, then sign in your wallet.'
    : 'Launch a coin with a wallet cap and a creator fee. Add an image and links, send it for approval, then sign in your wallet.'
  return { title: 'Launch a coin — repo.ing Hooks', description, robots: { index: false, follow: false } }
}
export default function WalletLaunchReview() {
  return <HooksLaunchPage/>
}
