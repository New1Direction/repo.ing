import Link from 'next/link'
import { AppHeader, Footer } from '../../components/ui'
import styles from '../../components/neurons-preview.module.css'

export const metadata = { title: 'Neuron Characters · repo.ing', description: 'Discover characters and preview the Neurons launch experience on repo.ing.', robots: { index: false, follow: false } }

export default function NeuronsLayout({ children }) {
  return <><div className={styles.siteHeader}><AppHeader active="neurons"/></div><div className={styles.shell}>
    <div className={styles.previewBar}><span><i/>NEURONS <b>PRODUCT PREVIEW</b></span><span>No real trades, tokens or earnings. <Link href="/neurons">Explore the experience ↗</Link></span></div>
    {children}
  </div><Footer/></>
}
