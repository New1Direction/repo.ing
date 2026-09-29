import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { ReminderLinkAction } from '../../../components/builder-reminders'
export const metadata = { title: 'Earnings reminders · repo.ing', robots: { index: false, follow: false }, referrer: 'no-referrer' }
export default function RemindersPage() {
  return <><AppHeader active="builders"/><main className="section-wrap launch-start"><ReminderLinkAction/><Link href="/builders" className="launch-find-link">Back to Builder dashboard →</Link></main><Footer/></>
}
