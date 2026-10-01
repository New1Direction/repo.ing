// A 96px pre-cropped cat (public/brand-cat.webp) covers the largest mark at 3x. fetchPriority="low" keeps React from
// adding a <link rel=preload> for it to every page head: it is never the LCP and the parser finds it immediately anyway.
export function BrandMark({ size = 32 }) {
  return <span className="brand-mark" role="img" aria-label="repo.ing cat" style={{ width: size, height: size }}>
    <img src="/brand-cat.webp" alt="" width={size} height={size} decoding="async" fetchPriority="low" />
  </span>
}
