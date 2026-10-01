'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { BadgeCheck, Coins, GitCommitHorizontal, GitMerge, Newspaper, Rocket, Star } from 'lucide-react'
import { pulseAge, pulseClusters, pulseDescribe, pulseHref, pulseLead, pulseLinkLabel, pulsePinLabel, pulseUtc } from '../lib/pulse-chart.mjs'

export const PULSE_ICONS = { release: Rocket, merge: GitMerge, commits: GitCommitHorizontal, stars: Star, hn: Newspaper, verified: BadgeCheck, paid: Coins }
// PIN_GAP: closest two pin centres may sit (a 22px pin plus room for its count badge) before they merge into one.
// TIP_TOP matches .pulse-tip's top so the card's height stops at the bottom of the chart.
const PIN_RADIUS = 11, PIN_GAP = 26, TIP_WIDTH = 260, TIP_EDGE = 8, TIP_TOP = 40, TIP_SHOWN = 3

// GitHub events along the top of the price pane. Pins follow the chart through pan, zoom, resize and new data; hover or
// focus previews an event with a guide line, a click/tap keeps its card open (Escape or a click elsewhere closes it).
export function ChartPulsePins({ chart, pins }) {
  const root = useRef(null), leaving = useRef(null), tipId = useId()
  const [placed, setPlaced] = useState([]), [pane, setPane] = useState(null)
  const [hovered, setHovered] = useState(null), [opened, setOpened] = useState(null)
  // A short grace period lets the pointer travel from a pin to its card without the card vanishing.
  const enter = time => { clearTimeout(leaving.current); setHovered(time) }
  const leave = () => { clearTimeout(leaving.current); leaving.current = setTimeout(() => setHovered(null), 160) }
  useEffect(() => () => clearTimeout(leaving.current), [])

  useEffect(() => {
    const scale = chart.timeScale()
    let frame = null
    // Scheduled, never immediate: the canvas applies new bars in its own effect, which runs after this child's.
    const place = () => {
      frame = null
      const size = chart.paneSize(0)
      setPane({ ...size, stage: root.current?.parentElement?.clientHeight ?? size.height })
      setPlaced(pulseClusters(pins.flatMap(pin => {
        const x = scale.timeToCoordinate(pin.time)
        return x === null || x < 0 || x > size.width ? [] : [{ ...pin, x }]
      }), PIN_GAP))
    }
    const schedule = () => { frame ??= requestAnimationFrame(place) }
    schedule()
    scale.subscribeVisibleLogicalRangeChange(schedule)
    scale.subscribeSizeChange(schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(root.current.parentElement)
    return () => {
      cancelAnimationFrame(frame); observer.disconnect()
      // The canvas may already have removed the chart when both unmount together.
      try { scale.unsubscribeVisibleLogicalRangeChange(schedule); scale.unsubscribeSizeChange(schedule) } catch { /* chart already removed */ }
    }
  }, [chart, pins])

  useEffect(() => {
    if (opened === null) return
    const closeOutside = event => { if (!root.current?.contains(event.target)) { setOpened(null); setHovered(null) } }
    const closeEscape = event => { if (event.key === 'Escape') { setOpened(null); setHovered(null) } }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [opened])

  if (!pane) return <div ref={root} className="pulse-lane" aria-hidden="true"/>
  const now = Date.now()
  const active = placed.find(pin => pin.time === (hovered ?? opened))
  const tipWidth = Math.min(TIP_WIDTH, pane.width - TIP_EDGE * 2)
  const tipLeft = active && Math.min(Math.max(active.x - tipWidth / 2, TIP_EDGE), pane.width - tipWidth - TIP_EDGE)
  return <div ref={root} className={`pulse-lane${active ? ' has-tip' : ''}`} role="group" aria-label="GitHub activity on this chart" style={{ width: pane.width, height: pane.height }}>
    {active && <span className={`pulse-guide is-${active.kind}`} style={{ transform: `translateX(${active.x}px)` }}/>}
    {placed.map(pin => {
      const Icon = PULSE_ICONS[pin.kind], open = opened === pin.time
      return <button key={pin.time} type="button" className={`pulse-pin is-${pin.kind}${open ? ' is-open' : ''}`}
        style={{ left: Math.min(Math.max(pin.x, PIN_RADIUS), pane.width - PIN_RADIUS) }}
        aria-label={pulsePinLabel(pin, now)} aria-expanded={open} aria-controls={open ? tipId : undefined}
        onClick={() => setOpened(open ? null : pin.time)} onPointerEnter={() => enter(pin.time)} onPointerLeave={leave}
        onFocus={() => enter(pin.time)} onBlur={leave}>
        <Icon size={12} strokeWidth={2.4} aria-hidden="true"/>{pin.count > 1 && <i className="pulse-pin-count" aria-hidden="true">{pin.count}</i>}
      </button>
    })}
    {active && <div id={tipId} className="pulse-tip" style={{ left: tipLeft, width: tipWidth, maxHeight: Math.max(120, pane.stage - TIP_TOP - TIP_EDGE) }} onPointerEnter={() => enter(active.time)} onPointerLeave={leave}>
      {pulseLead(active).slice(0, TIP_SHOWN).map(event => {
        const Icon = PULSE_ICONS[event.kind], href = pulseHref(event)
        return <div key={event.id} className={`pulse-tip-row is-${event.kind}`}>
          <Icon size={14} strokeWidth={2.2} className="pulse-tip-icon" aria-hidden="true"/>
          <strong className="pulse-tip-title">{pulseDescribe(event)}</strong>
          {event.detail && <span className="pulse-tip-detail" title={event.detail}>{event.detail}</span>}
          <span className="pulse-tip-meta"><time dateTime={new Date(event.time * 1000).toISOString()}>{pulseAge(event.time, now)} · {pulseUtc(event.time, now)}</time>
            {href && <a href={href} target="_blank" rel="noopener noreferrer">{pulseLinkLabel(event)}</a>}</span>
        </div>
      })}
      {active.count > TIP_SHOWN && <p className="pulse-tip-more">+{active.count - TIP_SHOWN} more at this time</p>}
    </div>}
  </div>
}
