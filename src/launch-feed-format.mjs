// Text forms of the launch feed (docs/MARKET_DATA_API.md#launch-feed): Atom for feed readers and an iCalendar file for calendar
// apps, whose own reminders are the notification. Pure functions: callers pass the events or calendar and the public origin.

const xml = value => String(value ?? '').replace(/[<>&'"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char])
  // Control characters other than tab and new line are not allowed in XML 1.0.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
const sol = lamports => `${(Number(BigInt(lamports ?? 0)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`
const buyText = lamports => (BigInt(lamports ?? 0) > 0n ? `with an initial buy of at most ${sol(lamports)}` : 'with no initial buy')
const utc = value => new Date(value).toISOString().replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, ' UTC')

// One line per event: what happened, in plain words.
export function eventTitle(event) {
  const data = event.data ?? {}, name = data.fullName ?? `repository ${event.repoId}`
  switch (event.kind) {
    case 'launch.scheduled': return `${name}: launch scheduled for ${utc(data.schedule?.scheduledAt)}`
    case 'launch.schedule_cancelled': return `${name}: scheduled launch cancelled`
    case 'launch.window_open': return `${name}: launch window open until ${utc(data.schedule?.windowEndsAt)}`
    case 'launch.schedule_lapsed': return `${name}: launch window passed without a launch`
    case 'market.launched': return `${name}: $${data.symbol ?? ''} launched${data.groupLaunch ? ' (Group launch)' : ''}`
    case 'market.graduated': return `${name}: $${data.symbol ?? ''} graduated to its DAMM v2 pool`
    case 'group_launch.raising': return `${name}: Group launch raising ${sol(data.targetLamports)} until ${utc(data.deadline)}`
    case 'group_launch.launched': return `${name}: Group launch filled and launched`
    case 'group_launch.failed': return `${name}: Group launch did not fill; backers can refund`
    default: return `${name}: ${event.kind}`
  }
}

export function eventSummary(event) {
  const data = event.data ?? {}
  if (event.kind.startsWith('launch.') && data.schedule) {
    const s = data.schedule
    return [`Announced by GitHub admin ${s.announcedBy}.`, `Only wallet ${s.launcherWallet} can launch during the ${s.windowMinutes}-minute window,`,
      `${buyText(s.maxInitialBuyLamports)} (never more than 3% of supply).`, s.note ? `Note: ${s.note}` : null].filter(Boolean).join(' ')
  }
  if (event.kind === 'market.launched') return `Mint ${data.mint}. Launched by wallet ${data.launcherWallet}. Transaction ${data.signature}.`
  if (event.kind === 'market.graduated') return `Migration transaction ${data.signature}; pool ${data.pool}. Migrated liquidity is permanently locked.`
  return eventTitle(event)
}

export function atomFeed(events, { origin, updated = new Date() }) {
  const self = `${origin}/launches.atom`
  const entries = events.map(event => {
    const link = `${origin}${event.data?.path ?? '/launches'}`
    return `  <entry>
    <id>${xml(`${origin}/api/v1/launches/events#${event.id}`)}</id>
    <title>${xml(eventTitle(event))}</title>
    <link href="${xml(link)}"/>
    <updated>${xml(event.occurredAt)}</updated>
    <category term="${xml(event.kind)}"/>
    <summary>${xml(eventSummary(event))}</summary>
  </entry>`
  }).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(self)}</id>
  <title>repo.ing launches</title>
  <subtitle>Scheduled launches, new markets, graduations and Group launch raises. Facts only; not an endorsement.</subtitle>
  <link rel="self" href="${xml(self)}"/>
  <link href="${xml(`${origin}/launches`)}"/>
  <updated>${xml((events[0]?.occurredAt ? new Date(events[0].occurredAt) : updated).toISOString())}</updated>
${entries}
</feed>
`
}

// RFC 5545: escape text, fold lines at 75 octets, CRLF line ends.
const icsText = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, match => `\\${match}`)
const icsTime = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
function fold(line) {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const parts = []
  let start = 0, first = true
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + (first ? 75 : 74))
    // Never split a UTF-8 sequence: back up to a lead byte.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    parts.push((first ? '' : ' ') + bytes.subarray(start, end).toString('utf8'))
    start = end
    first = false
  }
  return parts.join('\r\n')
}

export function icsCalendar({ scheduled = [], groupLaunches = [] }, { origin, now = Date.now() }) {
  const host = new URL(origin).host
  const stamp = icsTime(now)
  const events = []
  for (const s of scheduled) {
    events.push(['BEGIN:VEVENT', `UID:schedule-${s.id}@${host}`, `DTSTAMP:${stamp}`, `DTSTART:${icsTime(s.scheduledAt)}`, `DTEND:${icsTime(s.windowEndsAt)}`,
      `SUMMARY:${icsText(`${s.fullName ?? `Repository ${s.repoId}`} market launch window (repo.ing)`)}`,
      `DESCRIPTION:${icsText(`Announced by GitHub admin ${s.announcedBy}. Only wallet ${s.launcherWallet} can launch during this window, ${buyText(s.maxInitialBuyLamports)}. Not an endorsement or advice.`)}`,
      `URL:${origin}/launches#schedule-${s.id}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`${s.fullName ?? 'Scheduled'} launch window opens in 15 minutes`)}`,
      'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT'])
  }
  for (const b of groupLaunches) {
    const end = new Date(new Date(b.deadline).getTime() + 15 * 60_000)
    events.push(['BEGIN:VEVENT', `UID:group-${b.bundleId}@${host}`, `DTSTAMP:${stamp}`, `DTSTART:${icsTime(b.deadline)}`, `DTEND:${icsTime(end)}`,
      `SUMMARY:${icsText(`${b.fullName ?? `Repository ${b.repoId}`} Group launch deadline (repo.ing)`)}`,
      `DESCRIPTION:${icsText(`A Group launch raise for $${b.symbol} closes. All or nothing: it launches if ${sol(b.targetLamports)} is raised, otherwise backers can refund.`)}`,
      `URL:${origin}${b.path ?? `/group/${b.bundleId}`}`, 'END:VEVENT'])
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//repo.ing//launch calendar//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:repo.ing launches', ...events.flat(), 'END:VCALENDAR']
  return lines.map(fold).join('\r\n') + '\r\n'
}
