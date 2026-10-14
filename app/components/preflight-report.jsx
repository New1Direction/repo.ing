// The launch preflight (src/launch-preflight.mjs) as a page section: the verdict, every requirement with what to do about it, and
// the pre-launch Launch Quality facts with their sources and explicit unknowns. Presentational: actions are callbacks from the guide.
const STATUS_LABEL = { pass: 'Pass', warn: 'Caution', fail: 'Fail', unknown: 'Unknown', info: 'Info' }
const REQUIREMENT_LABEL = { met: 'Met', warn: 'Check', missing: 'Missing', blocked: 'Blocked', unknown: 'Unknown', info: 'Info' }
const BASIS_LABEL = { observed: 'From GitHub and repo.ing', plan: 'From your plan', config: 'From the launch config', 'after-launch': 'After launch' }
const VERDICT = {
  ready: ['Ready to schedule', 'Every requirement for a scheduled launch is met. Review the disclosures and the preview, then publish.'],
  'needs-action': ['Needs action', 'Some requirements are missing. Each one says exactly what to do.'],
  blocked: ['Cannot launch now', 'This repository cannot launch right now, whoever asks. The blocked items say why.'],
}
const utc = value => (value ? `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '—')

function Remediation({ remediation, onAction, actions }) {
  if (!remediation) return null
  const action = remediation.action && onAction && actions.includes(remediation.action)
    ? <button type="button" className="guide-link-button" onClick={() => onAction(remediation.action)}>{remediation.action === 'retry' ? 'Check again' : 'Edit the plan'}</button> : null
  const external = remediation.href && /^https:/.test(remediation.href)
  return <p className="guide-remedy"><strong>What to do:</strong> {remediation.text}{' '}
    {remediation.href && <a href={remediation.href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{remediation.label ?? 'Open'}{external ? ' ↗' : ''}</a>}{action}</p>
}

export function PreflightRequirements({ preflight, onAction, only = null, actions = ['retry', 'plan'] }) {
  const items = preflight.requirements.filter(item => !only || only.includes(item.group))
  const groups = [...new Set(items.map(item => item.group))]
  return groups.map(group => <div key={group} className="transparency-group"><h4>{group}</h4>
    <ul className="transparency-criteria guide-requirements">{items.filter(item => item.group === group).map(item => <li key={item.id} className={`is-req-${item.status}`}>
      <span className="transparency-status">{REQUIREMENT_LABEL[item.status]}</span>
      <div><strong>{item.label}</strong>{item.detail && <p>{item.detail}</p>}
        <Remediation remediation={item.status === 'met' ? null : item.remediation} onAction={onAction} actions={actions}/>
        {item.evidence && <small>{item.evidence.ref ? <a href={item.evidence.ref} target="_blank" rel="noreferrer">{item.evidence.source} ↗</a> : item.evidence.source}{item.evidence.observedAt ? ` · ${utc(item.evidence.observedAt)}` : ''}</small>}
        {item.requiredFor.length === 0 && item.status !== 'met' && <small>Advisory: not required to publish.</small>}</div>
    </li>)}</ul></div>)
}

export function PreflightQuality({ quality, checkedAt }) {
  const groups = [...new Set(quality.criteria.map(item => item.group))]
  return <section className="inner-card transparency-card" aria-labelledby="preflight-quality-title">
    <div className="transparency-score-head"><h3 id="preflight-quality-title">Launch Quality, before launch</h3>
      <div className="transparency-score"><strong>{quality.score === null ? '—' : quality.score}<span>/100</span></strong>
        <small>{quality.coveragePercent}% of pre-launch criteria known · {utc(checkedAt)}</small></div></div>
    <p className="transparency-lede">{quality.summary}. The same criteria and scoring as each market&apos;s public report, over what can be known before a market exists. Facts with their sources, not a rating to buy. Nothing anyone pays, and no price or volume amount, can change it; a score below {quality.minCoveragePercent}% coverage is not shown.</p>
    {quality.unknowns.length > 0 && <div className="transparency-unknowns"><strong>Unknown now:</strong><ul>{quality.unknowns.map(item => <li key={item.id}>{item.label}{item.reason ? `: ${item.reason}` : ''}</li>)}</ul></div>}
    <div className="transparency-unknowns"><strong>Measured only after launch</strong> (left out of this score; the public report starts with them unknown, so its score can differ):
      <ul>{quality.afterLaunch.map(item => <li key={item.id}>{item.label}: {item.reason}</li>)}</ul></div>
    {groups.map(group => <div key={group} className="transparency-group"><h4>{group}</h4><ul className="transparency-criteria">
      {quality.criteria.filter(item => item.group === group).map(item => <li key={item.id} className={`is-${item.status} basis-${item.basis}`}>
        <span className="transparency-status">{item.basis === 'after-launch' ? 'Later' : STATUS_LABEL[item.status]}</span>
        <div><strong>{item.label}</strong> <span className="guide-basis">{BASIS_LABEL[item.basis]}</span>{item.value && <span className="transparency-value">{item.value}</span>}
          {item.note && <p>{item.note}</p>}
          {item.evidence.length > 0 && <small>{item.evidence.map((evidence, index) => <span key={index}>{evidence.ref ? <a href={evidence.ref} target="_blank" rel="noreferrer">{evidence.source} ↗</a> : evidence.source}{evidence.observedAt ? ` · ${utc(evidence.observedAt)}` : ''}</span>)}</small>}</div>
        {item.max > 0 && <span className="transparency-points">{item.status === 'unknown' || item.basis === 'after-launch' ? '—' : item.points}/{item.max}</span>}
      </li>)}</ul></div>)}
    <p className="transparency-excluded">Never inputs: {quality.excludedInputs.join(', ')}.</p>
  </section>
}

export function PreflightVerdict({ preflight }) {
  const [title, text] = VERDICT[preflight.verdict]
  return <div className={`guide-verdict is-${preflight.verdict}`} role="status"><strong>{title}</strong><span>{text}</span></div>
}
