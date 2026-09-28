// A 96px pre-cropped cat (public/brand-cat.webp) covers the largest mark at 3x.
export function BrandMark({ size = 32 }) {
  return <span className="brand-mark" role="img" aria-label="repo.ing cat" style={{ width: size, height: size }}>
    <img src="/brand-cat.webp" alt="" width={size} height={size} decoding="async" />
  </span>
}
