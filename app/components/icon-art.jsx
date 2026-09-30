// Soft 3D illustrations from the repo.ing icon pack (public/art: transparent WebP cutouts of the owner's originals).
// Rendered directly on the page with no tile; app/art.css adds a theme-tuned drop shadow. Always decorative: the text
// beside it carries the meaning. The art is conceptual only; it never stands in for the canonical logo or product data.
import { ART, artSource } from '../lib/art.mjs'

// `size` is the CSS display size in px (the files are exported at 2× or more); CSS may shrink it on phones.
export function IconArt({ name, size, eager = false }) {
  if (!ART[name]) throw new Error(`Unknown art: ${name}`)
  return <img className="icon-art" style={{ '--art-size': `${size}px` }} src={artSource(name)} alt="" aria-hidden="true"
    width={size} height={size} loading={eager ? 'eager' : 'lazy'} decoding="async"/>
}
