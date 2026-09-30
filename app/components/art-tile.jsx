// Soft 3D illustrations from the repo.ing icon pack (public/art, WebP derivatives of the owner's originals).
// The art has an opaque light studio background, so it always sits on its own light tile — in dark mode it reads
// as a lit card, not a pasted square. Always decorative: the text beside it carries the meaning. The art is
// conceptual only; it never stands in for the canonical logo or for product data.
import { ART, artSource } from '../lib/art.mjs'

// `size` is the CSS display size in px (the files are exported at 2× or more); CSS may shrink it on phones.
export function ArtTile({ name, size, eager = false }) {
  const art = ART[name]
  if (!art) throw new Error(`Unknown art: ${name}`)
  return <div className="art-tile" style={{ '--art-size': `${size}px`, '--art-bg': art.background }} aria-hidden="true">
    <img src={artSource(name)} alt="" width={size} height={size} loading={eager ? 'eager' : 'lazy'} decoding="async"/>
  </div>
}
