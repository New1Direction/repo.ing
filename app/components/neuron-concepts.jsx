import styles from './neurons-preview.module.css'

export function NeuronConcepts({ concepts }) {
  if (!concepts) return null
  const method = { 'j-lens': 'J-lens', 'r-lens': 'R-lens', 'logit-lens': 'Logit lens', creator: 'Manual tags' }[concepts.method]
  return <section className={styles.associatedConcepts} aria-label="Associated concepts">
    <div><h3>Associated concepts</h3><a href={concepts.sourceUrl} target="_blank" rel="noreferrer">View source ↗</a></div>
    <ul>{concepts.terms.map(term => <li key={term}>{term}</li>)}</ul>
    <p>{method} · Creator-supplied, not verified traits.</p>
  </section>
}
