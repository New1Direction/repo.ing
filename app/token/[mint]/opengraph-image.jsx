import { ImageResponse } from 'next/og'
import sharp from 'sharp'
import { database, marketByMint } from '../../lib/server.mjs'
import { GET as repositoryLogo } from '../../api/repo-logo/[repo]/route'
export const runtime = 'nodejs'
export const alt = 'Repository market on repo.ing'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function Image({ params }) {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  if (!market) return new Response('Market not found', { status: 404 })
  let logo = null
  try {
    const { rows } = await database().query('select token_image from markets where mint=$1', [mint])
    logo = rows[0]?.token_image || null
  } catch { /* Legacy markets can still resolve their repository artwork below. */ }
  if (!logo) {
  try {
    const result = await repositoryLogo(null, { params: Promise.resolve({ repo: market.repoId }) })
    const location = result.headers.get('location')
    if (location) {
      const response = await fetch(location, { signal: AbortSignal.timeout(4000) })
      if (response.ok && Number(response.headers.get('content-length')) <= 2_000_000) {
        const reader = response.body.getReader(); const parts = []; let bytes = 0
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          bytes += value.byteLength
          if (bytes > 2_000_000) { await reader.cancel(); throw Error('Image too large') }
          parts.push(Buffer.from(value))
        }
        const png = await sharp(Buffer.concat(parts), { limitInputPixels: 10_000_000 }).resize(156, 156, { fit: 'contain', background: '#161b22' }).png().toBuffer()
        logo = `data:image/png;base64,${png.toString('base64')}`
      }
    }
  } catch { /* The share card remains readable when the repository image is unavailable. */ }
  }
  return new ImageResponse(<div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#0d1117', color: '#f0f6fc', padding: 64, fontFamily: 'sans-serif' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 28, color: '#7ee2ad' }}><span>repo.ing</span><span>Open source markets</span></div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 36, marginTop: 70 }}>{logo ? <img src={logo} width={156} height={156} style={{ width: 156, height: 156, flexShrink: 0, borderRadius: 24 }}/> : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 156, height: 156, flexShrink: 0, background: '#21262d', borderRadius: 24, fontSize: 72 }}>$</div>}<div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: 860, minWidth: 0 }}><strong style={{ fontSize: 64, maxWidth: 860 }}>${market.symbol.slice(0, 16)}</strong><span style={{ fontSize: 32, width: 860, color: '#b1bac4', overflow: 'hidden' }}>{market.fullName.slice(0, 65)}</span></div></div>
    <p style={{ fontSize: 28, lineHeight: 1.4, color: '#b1bac4', marginTop: 36 }}>{(market.description || 'Explore this repository market on repo.ing.').slice(0, 155)}</p>
    <div style={{ display: 'flex', marginTop: 'auto', fontSize: 22, color: '#7ee2ad' }}>Every trade pays the builders.</div>
  </div>, { ...size, headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' } })
}
