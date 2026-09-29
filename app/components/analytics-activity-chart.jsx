'use client'
import { useState } from 'react'
import { formatUnits, formatSolDisplay } from '../lib/format.mjs'

export function AnalyticsActivityChart({ data, metric, title }) {
  const [selected, setSelected] = useState(null)
  const maximum = data.days.reduce((max, day) => BigInt(day[metric]) > max ? BigInt(day[metric]) : max, 0n)
  const label = day => new Date(day).toLocaleString('en-US', data.bucket === 'hour' ? { month: 'short', day: 'numeric', hour: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const current = data.days[selected] ?? data.days.at(-1)
  return <div className="analytics-chart">
    <div className="analytics-hover-value"><span>{label(current.bucket)} UTC</span><strong title={`${formatUnits(current[metric])} SOL`}>{formatSolDisplay(current[metric])} SOL</strong></div>
    <div className="analytics-bars" aria-label={`${title}, ${data.bucket === 'hour' ? 'hourly' : 'daily'} in UTC`} onMouseLeave={() => setSelected(null)}>
      {data.days.map((day, index) => <button type="button" key={day.bucket} className={`analytics-bar-button${selected === index ? ' selected' : ''}`} onMouseEnter={() => setSelected(index)} onFocus={() => setSelected(index)} onBlur={() => setSelected(null)} onClick={() => setSelected(index)} aria-label={`${label(day.bucket)} UTC: ${formatSolDisplay(day[metric])} SOL ${title.toLowerCase()}`}><span style={{ height: `${maximum === 0n ? 0 : Number(BigInt(day[metric]) * 10000n / maximum) / 100}%` }}/></button>)}
      {maximum === 0n && <span className="analytics-no-activity">No recorded activity</span>}
    </div>
    <div className="analytics-axis"><span>{label(data.days[0].bucket)}</span><span>{label(data.days.at(-1).bucket)}</span></div>
    <details className="analytics-data"><summary>View data</summary><div className="analytics-data-scroll"><table><caption>{title} · {data.bucket === 'hour' ? 'hourly' : 'daily'} UTC</caption><thead><tr><th>Time</th><th>SOL</th></tr></thead><tbody>{data.days.map(day => <tr key={day.bucket}><td>{day.bucket.replace('T', ' ').slice(0, 16)}</td><td>{formatUnits(day[metric])}</td></tr>)}</tbody></table></div></details>
  </div>
}
