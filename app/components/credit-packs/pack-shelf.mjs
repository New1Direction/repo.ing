import { TIERS } from './packs-model.mjs'
import { labelFor, renderer } from './pack-art.mjs'

// The shelf on /credits: each pack drawn live in WebGL, leaning toward the pointer, its light following it; idle packs
// drift. Packs off screen are not drawn. Returns null without WebGL (the page shows its CSS packs instead).
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
export function createShelf(buttons) {
  const packs = []
  for (const button of buttons) {
    const price = Number(button.dataset.price), canvas = button.querySelector('.pack-canvas'), art = button.querySelector('.pack-art')
    let gl = null
    try { gl = renderer(canvas) } catch { gl = null }
    if (!gl) { for (const p of packs) p.gl.release(); return null }
    const pack = { price, button, art, gl, seed: TIERS.indexOf(price) * 3.7 + 1.3, tilt: [0, 0], target: [0, 0], hover: false, visible: true }
    pack.move = event => {
      const r = art.getBoundingClientRect()
      pack.target = [((event.clientX - r.left) / r.width) * 2 - 1, 1 - ((event.clientY - r.top) / r.height) * 2]
      pack.hover = true
    }
    pack.leave = () => { pack.hover = false; pack.target = [0, 0] }
    button.addEventListener('pointermove', pack.move)
    button.addEventListener('pointerleave', pack.leave)
    packs.push(pack)
  }
  let live = true
  for (const p of packs) labelFor(p.price).then(label => { if (live) { p.gl.setLabel(label); p.button.classList.add('is-ready') } })
  const io = new IntersectionObserver(entries => { for (const e of entries) { const p = packs.find(x => x.button === e.target); if (p) p.visible = e.isIntersecting } })
  for (const p of packs) io.observe(p.button)
  let frame = 0
  const loop = now => {
    const t = now / 1000, still = reducedMotion()
    if (!document.hidden) for (const p of packs) {
      if (!p.visible) continue
      p.tilt[0] += (p.target[0] - p.tilt[0]) * 0.12; p.tilt[1] += (p.target[1] - p.tilt[1]) * 0.12
      const idle = still ? [0.25, 0.35] : [Math.sin(t * 0.5 + p.seed) * 0.55, Math.cos(t * 0.37 + p.seed) * 0.4]
      const light = p.hover ? [p.tilt[0] * 0.9, p.tilt[1] * 0.9] : idle
      p.art.style.transform = still ? '' : `perspective(900px) rotateY(${p.tilt[0] * 14}deg) rotateX(${p.tilt[1] * -12}deg)`
      p.gl.draw({ price: p.price, time: still ? 0 : t, light, seed: p.seed })
    }
    frame = requestAnimationFrame(loop)
  }
  frame = requestAnimationFrame(loop)
  return {
    destroy() {
      live = false
      cancelAnimationFrame(frame); io.disconnect()
      for (const p of packs) { p.button.removeEventListener('pointermove', p.move); p.button.removeEventListener('pointerleave', p.leave); p.gl.release() }
    },
  }
}
