export function BrandMark({ size = 32 }) {
  const crop = 382
  return <span className="brand-mark" role="img" aria-label="repo.ing cat" style={{ width: size, height: size }}>
    <img src="/gitcat.png" alt="" width={1448 * size / crop} height={1086 * size / crop}
      style={{ left: -72 * size / crop, top: -355 * size / crop }} />
  </span>
}
