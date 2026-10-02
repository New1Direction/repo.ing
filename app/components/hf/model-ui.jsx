import { ArrowUpRight, BrainCircuit, Clock3, Download, GitBranch, Heart, Info, Lock, Scale } from 'lucide-react'
import { HF_DISCLAIMER, HF_DISCLAIMER_BADGE, MODEL_SOURCE_LABEL, MODEL_SOURCE_TITLE, compactCount, derivativeLabel, exactCount } from '../../lib/hf-model-display.mjs'
import '../../hf-models.css'

// Pieces shared by every Hugging Face model surface (list rows, cards, the token page). Server and client safe. Text
// labels only: the Hugging Face logo is never used.

export function ModelSourceChip({ compact = false }) {
  return <span className={`source-chip is-model${compact ? ' compact' : ''}`} title={MODEL_SOURCE_TITLE}>{MODEL_SOURCE_LABEL}</span>
}

export function CommunityLaunchBadge() {
  return <span className="badge community-launch" title={HF_DISCLAIMER}>{HF_DISCLAIMER_BADGE}</span>
}

// The disclaimer badge as its own line in a market card (cards are too narrow for a second chip).
export function ModelCardBadge() {
  return <p className="model-card-badge" title={HF_DISCLAIMER}>{HF_DISCLAIMER_BADGE}</p>
}

// The full disclaimer. Every page that shows a model shows this once (badges alone are not enough).
export function ModelDisclaimer({ className = '' }) {
  return <p className={`model-disclaimer${className ? ` ${className}` : ''}`} role="note"><Info size={14} aria-hidden="true"/><span>{HF_DISCLAIMER}</span></p>
}

// Avatar placeholder for a model without artwork (GitHub markets show the GitHub mark).
export const ModelMark = ({ size = 24 }) => <BrainCircuit size={size} aria-hidden="true"/>

export function HuggingFaceLink({ url, className = 'button outline github-link model-link' }) {
  if (!url) return null
  return <a className={className} href={url} target="_blank" rel="noreferrer">View on Hugging Face<ArrowUpRight size={16} aria-hidden="true"/></a>
}

// "4,194 likes on Hugging Face", or that they are unknown (display-only likes come from the live model card).
export const likesTitle = likes => likes === null || likes === undefined ? 'Likes unavailable right now' : `${exactCount(likes)} likes on Hugging Face`

// The likes cell in market tables, which doubles as the row's link to the model page (the row itself links to the market).
export function ModelLikesCell({ likes, url, path }) {
  const title = `${likesTitle(likes)}${url ? ` · open ${path} on Hugging Face` : ''}`
  const content = <><Heart size={15} aria-hidden="true"/>{compactCount(likes)}<span className="sr-only"> likes{url ? `, open ${path} on Hugging Face` : ''}</span></>
  return url ? <a className="table-stars table-likes" href={url} target="_blank" rel="noreferrer" title={title}>{content}</a>
    : <span className="table-stars table-likes" title={title}>{content}</span>
}

// Likes, 30-day downloads and, in detail, the task and last update: the model's counterpart of RepoStats.
export function ModelStats({ view, detailed = false }) {
  return <div className="repo-stats model-stats">
    <span title={likesTitle(view.likes)}><Heart size={18} aria-hidden="true"/>{compactCount(view.likes)}<small>likes</small></span>
    <span title={view.downloads30d === null ? 'Downloads unavailable right now' : `${exactCount(view.downloads30d)} downloads in the last 30 days`}><Download size={18} aria-hidden="true"/>{compactCount(view.downloads30d)}<small>downloads (30d)</small></span>
    {detailed && <><span title="Task on Hugging Face"><BrainCircuit size={18} aria-hidden="true"/>{view.task || (view.live ? 'Task not set' : '—')}</span>
      <span><Clock3 size={18} aria-hidden="true"/>{view.updatedAt ? new Date(view.updatedAt).toLocaleDateString('en-US', { timeZone: 'UTC' }) : '—'}</span></>}
  </div>
}

// Facts that change how a model can be used: gated access, license, and what it was derived from. links: the derivative
// badge links to its base model (never inside another link). lead: a badge shown first (the token page's disclaimer badge).
export function ModelBadges({ view, links = true, lead = null }) {
  const derivative = derivativeLabel(view.base)
  if (!lead && !view.gated && !view.license && !derivative) return null
  return <span className="model-badges">
    {lead}
    {view.gated && <span className="badge model-gated" title={view.gated.title}><Lock size={12} aria-hidden="true"/><span>{view.gated.label}</span></span>}
    {view.license && <span className="badge model-license" title="License on Hugging Face"><Scale size={12} aria-hidden="true"/><span>{view.license}</span></span>}
    {derivative && (links && derivative.href
      ? <a className="badge model-derivative" href={derivative.href} target="_blank" rel="noreferrer" title={derivative.title}><GitBranch size={12} aria-hidden="true"/><span>{derivative.label}</span></a>
      : <span className="badge model-derivative" title={derivative.title}><GitBranch size={12} aria-hidden="true"/><span>{derivative.label}</span></span>)}
  </span>
}
