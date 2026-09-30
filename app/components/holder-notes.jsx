import { HolderNotesList } from './holder-notes-list'
import { holderNotesPage } from '../lib/holder-notes.mjs'

// Token page: "Why holders bought". Streams in behind a same-size fallback; below recent trades on desktop,
// after the tip card on mobile.
export async function HolderNotes({ market }) {
  let initial
  try { initial = await holderNotesPage(market.mint) } catch { initial = { notes: [], hasMore: false, unavailable: true } }
  return <section className="inner-card holder-notes" aria-labelledby="holder-notes-title">
    <HolderNotesList mint={market.mint} symbol={market.symbol} initial={initial}/>
  </section>
}

export const HolderNotesFallback = () => <section className="inner-card holder-notes" aria-busy="true" aria-labelledby="holder-notes-title">
  <div className="holder-notes-heading"><h3 id="holder-notes-title">Why holders bought</h3><span className="holder-notes-add is-loading" aria-hidden="true">Add your note</span></div>
  <ol className="holder-notes-list" aria-hidden="true">{[0, 1, 2].map(i => <li key={i} className="holder-note is-placeholder"><span className="skeleton-text"/><span className="skeleton-text"/></li>)}</ol>
</section>
