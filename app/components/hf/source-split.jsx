import { formatSolDisplay } from '../../lib/format.mjs'
import { shareLabel, splitShare } from '../../lib/builder-split.mjs'
import '../../hf-models.css'

const METRICS = [['volume', 'Trading volume'], ['earned', 'Builder fees earned'], ['paid', 'Builder payouts']]
const SOURCES = [['github', 'GitHub repos', ''], ['huggingface', 'Hugging Face models', 'is-model']]

// /stats (HF_MARKETS_ENABLED only): each figure split between GitHub repositories and Hugging Face models. sources comes
// from the same read-only snapshot as the totals (src/protocol-analytics.mjs), so each pair adds up to its total.
export function SourceSplit({ sources }) {
  if (!sources?.github || !sources?.huggingface) return null
  return <section className="source-split" aria-labelledby="source-split-title">
    <div className="source-split-heading"><h2 id="source-split-title">By market source</h2>
      <p>{sources.github.markets} repository {sources.github.markets === 1 ? 'market' : 'markets'} and {sources.huggingface.markets} model {sources.huggingface.markets === 1 ? 'market' : 'markets'}, from the same snapshot as the figures above. Each pair adds up to its total.</p></div>
    <div className="source-split-grid">{METRICS.map(([metric, label]) => {
      const total = BigInt(sources.github[metric]) + BigInt(sources.huggingface[metric])
      const github = splitShare(sources.github[metric], total)
      return <article key={metric}><h3>{label}</h3>
        <span className={`source-split-bar${github === null ? ' is-empty' : ''}`} aria-hidden="true">{github !== null && <span style={{ width: `${github}%` }}/>}</span>
        <dl>{SOURCES.map(([source, name, tone]) => {
          const share = splitShare(sources[source][metric], total)
          return <div key={source}><dt><i className={tone || undefined} aria-hidden="true"/>{name}</dt>
            <dd>{formatSolDisplay(sources[source][metric])} SOL{share !== null && <small>{shareLabel(share)}</small>}</dd></div>
        })}</dl>
      </article>
    })}</div>
  </section>
}
