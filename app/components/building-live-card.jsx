'use client'
import { useEffect, useState } from 'react'
import { ArrowUpRight, RadioTower } from 'lucide-react'
import styles from './builder-kit.module.css'

// Token page side card: the verified maintainer's stream as a plain outbound link (never embedded). It renders the
// server's live state, then goes idle by itself when the window ends; a refreshed window turns it live again.
export function BuildingLiveCard({ stream }) {
  const [live, setLive] = useState(stream.live)
  useEffect(() => {
    const left = stream.live ? Date.parse(stream.liveUntil) - Date.now() : 0
    setLive(left > 0)
    if (!(left > 0)) return
    const timer = setTimeout(() => setLive(false), Math.min(left, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [stream.live, stream.liveUntil])
  const target = new URL(stream.url), place = `${target.hostname.replace(/^www\./, '')}${target.pathname}`.replace(/\/$/, '')
  return <section className={`inner-card ${styles.building}${live ? ` ${styles.isLive}` : ''}`} aria-labelledby="building-live-title">
    <div className={styles.buildingTop}><h3 id="building-live-title"><RadioTower size={16} aria-hidden="true"/>Building live</h3>
      {live && <span className={styles.liveBadge}>LIVE</span>}</div>
    <p>{live ? `The maintainer is streaming the build on ${stream.platform} right now.` : `The maintainer streams the build on ${stream.platform}.`}</p>
    <a className={`button ${live ? 'primary' : 'outline'} ${styles.watch}`} href={stream.url} target="_blank" rel="noopener noreferrer nofollow">
      Watch on {stream.platform}<ArrowUpRight size={16} aria-hidden="true"/></a>
    <span className={styles.host} title={stream.url}>{place}</span>
  </section>
}
