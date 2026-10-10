import { createCard } from './card-art.mjs'
import { STYLE, fontsOf, labelFor, loadCat, loadImage, renderer } from './pack-art.mjs'
import { PACK_NAMES, money, rarityOf, times } from './packs-model.mjs'

// The opening stage on /credits, over the page: the pack waits (shaking) while the payment finalizes; then the top strip
// tears off for real (the tear runs from the notch, the torn part curls up in 3D showing its silver inside, foil flecks
// fall, the strip is thrown aside), the card comes out and flips (card-art.mjs), and the stage takes the rarity's colour.
// The stage only shows a spin the credit service already made and repo.ing already checked (src/credits-packs.mjs).
// Without WebGL the pack and card are CSS; with reduced motion the card is shown at once. Browser only.
const RARITY_COLOR = { common: '#aab6c3', rare: '#5ec8ff', epic: '#b98cff', legendary: '#ffc94d' }
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// The tear: a short grip, then the tear runs from the notch to the far side in about half a second. It resists, gives,
// catches and runs (stick-slip), and the torn part curls up more the further it goes. Then the strip comes free.
const CLOSED = Symbol('closed')
const GRIP_MS = 150, TEAR_MS = 560, FLY_MS = 760, NOTCH = 0.93, FAR_SIDE = 0.03, TEAR_LINE = 0.86

const MARKUP = `<div class="stage-backdrop" aria-hidden="true"></div><div class="stage-spot" aria-hidden="true"></div><div class="stage-rays" aria-hidden="true"><i></i><i></i></div>
  <div class="stage-pack"><div class="stage-floor" aria-hidden="true"></div><div class="stage-card"><div class="card-aura" aria-hidden="true"></div><canvas class="card-gl" aria-hidden="true"></canvas><div class="card-flash" aria-hidden="true"></div><div class="card-inner"><div class="card-face card-back"><img class="card-back-word" src="/credits/repoing-wordmark.png" alt=""><img class="card-back-logo" src="/credits/repoing-mark.png" alt=""></div><div class="card-face card-front"><div class="card-top"><span class="card-rarity"></span><b class="card-mult"></b></div><div class="card-art"><img src="/credits/repocat-512.png" alt=""></div><strong class="card-total"></strong><span class="card-unit">of AI credits</span><span class="card-split"></span><span class="card-foot"></span></div></div></div>
  <canvas class="stage-body" aria-hidden="true"></canvas><canvas class="stage-strip" aria-hidden="true"></canvas><div class="stage-css-pack" aria-hidden="true"></div></div>
  <canvas class="stage-burst" aria-hidden="true"></canvas><canvas class="stage-flecks" aria-hidden="true"></canvas>
  <p class="stage-status" aria-live="polite"></p>
  <div class="stage-actions" hidden><button type="button" class="button primary stage-again">Open another</button><button type="button" class="button outline stage-done">Done</button></div>
  <button type="button" class="stage-hide" hidden>Close · repo.ing keeps checking</button>`

/** onDone: Done or Escape after the reveal. onAgain: "Open another". onHide: closed while the payment finalizes. */
export function createPackStage({ onDone, onAgain, onHide }) {
  const root = document.createElement('div')
  root.className = 'pack-stage'; root.hidden = true
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Opening your pack')
  root.innerHTML = MARKUP
  // the page's brand fonts: the stage hangs off <body>, outside the page's font variables
  root.style.setProperty('--display', fontsOf().display); root.style.setProperty('--mono', fontsOf().mono)
  document.body.append(root)
  const q = selector => root.querySelector(selector)
  const s = { glBody: null, glStrip: null, glCard: undefined, card: q('.stage-card'), status: q('.stage-status'), actions: q('.stage-actions'), hide: q('.stage-hide'),
    burst: q('.stage-burst'), flecks: q('.stage-flecks'), pack: q('.stage-pack'), price: 10, tearing: false, tearAt: 0, tearP: 0, shed: 0, open: false, ready: null }
  try { s.glBody = renderer(q('.stage-body')); s.glStrip = renderer(q('.stage-strip'), true) } catch { s.glBody?.release(); s.glBody = s.glStrip = null }
  let returnFocus = null, frame = 0

  // the card leans toward the pointer anywhere on the stage (a drag on touch screens); the CSS card's sheen follows it
  const onCardMove = event => {
    const r = s.card.getBoundingClientRect()
    s.card.style.setProperty('--mx', `${((event.clientX - r.left) / r.width) * 100}%`)
    s.card.style.setProperty('--my', `${((event.clientY - r.top) / r.height) * 100}%`)
  }
  const onMove = event => {
    if (!s.glCard || reducedMotion()) return
    const r = s.card.getBoundingClientRect()
    s.glCard.pointer((event.clientX - r.left - r.width / 2) / r.width * 1.6, -(event.clientY - r.top - r.height / 2) / r.height * 1.6)
  }
  const onRelease = event => { if (event.type !== 'pointerup' || event.pointerType !== 'mouse') s.glCard?.pointer(0, 0) }
  const onKey = event => { if (event.key === 'Escape' && !s.actions.hidden) { close(true); onDone?.() } }
  s.card.addEventListener('pointermove', onCardMove)
  root.addEventListener('pointermove', onMove)
  for (const type of ['pointerleave', 'pointercancel', 'pointerup']) root.addEventListener(type, onRelease)
  root.addEventListener('keydown', onKey)
  q('.stage-done').addEventListener('click', () => { close(true); onDone?.() })
  q('.stage-again').addEventListener('click', () => { close(false); onAgain?.() })
  s.hide.addEventListener('click', () => { close(true); onHide?.() })

  const tearState = now => {
    if (!s.tearAt) return { front: 1, curl: 0, lift: 0, fly: 0, alpha: 1 }
    const e = now - s.tearAt, t = Math.min(1, Math.max(0, e / TEAR_MS))
    s.tearP = Math.max(s.tearP, Math.min(1, Math.pow(t, 1.5) + 0.035 * Math.sin(t * Math.PI * 4) * (1 - t)))
    const fly = Math.min(1, Math.max(0, (e - TEAR_MS) / FLY_MS))
    return { front: NOTCH - s.tearP * (NOTCH - FAR_SIDE), curl: 0.3 + s.tearP * 0.95, lift: 0.1 * s.tearP, fly, alpha: 1 - Math.max(0, fly - 0.5) / 0.5 }
  }
  const draw = now => {
    const t = now / 1000, still = reducedMotion()
    if (!document.hidden) {
      const light = still ? [0.3, 0.3] : [Math.sin(t * 0.9) * 0.6, Math.cos(t * 0.6) * 0.35 + 0.1]
      const tear = tearState(performance.now())
      s.glBody?.draw({ price: s.price, time: t, light, seed: 4.2, part: s.tearing ? 1 : 0, front: tear.front })
      if (s.tearing) s.glStrip?.draw({ price: s.price, time: t, light, seed: 4.2, part: 2, ...tear })
      // foil flecks shed at the tear front as it runs, and a few more when the strip comes free
      const want = Math.floor(s.tearP * 34) + (tear.fly > 0 ? 8 : 0)
      if (want > s.shed) {
        const r = s.pack.getBoundingClientRect()
        fleckEmit(r.left + Math.max(0.07, tear.front) * r.width, r.top + (1 - TEAR_LINE) * r.height, want - s.shed)
        s.shed = want
      }
      s.glCard?.draw(t, still)
    }
    frame = s.open ? requestAnimationFrame(draw) : 0
  }

  // Foil flecks from the tear, on a canvas in front of the pack: tiny bits that spin (flashing when they face the light)
  // and fall.
  const flecks = { raf: 0, ctx: null, w: 0, h: 0, parts: [] }
  function fleckEmit(x, y, count) {
    if (reducedMotion()) return
    const color = `rgb(${STYLE[s.price].foil.map(c => Math.round(Math.min(1, c * 1.15) * 255)).join(',')})`
    for (let i = 0; i < count; i++) flecks.parts.push({ x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 5,
      vx: (Math.random() - 0.6) * 190, vy: -(50 + Math.random() * 190), spin: Math.random() * 6.28, vs: 7 + Math.random() * 15,
      w: 1.6 + Math.random() * 3.2, h: 1 + Math.random() * 1.8, life: 0, span: 0.6 + Math.random() * 0.7, white: Math.random() < 0.3, color })
    if (flecks.raf) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    flecks.w = innerWidth; flecks.h = innerHeight; s.flecks.width = flecks.w * dpr; s.flecks.height = flecks.h * dpr
    flecks.ctx = s.flecks.getContext('2d'); flecks.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    let last = performance.now()
    const tick = now => {
      const dt = Math.min(0.05, (now - last) / 1000), ctx = flecks.ctx; last = now
      ctx.clearRect(0, 0, flecks.w, flecks.h)
      flecks.parts = flecks.parts.filter(p => (p.life += dt) < p.span)
      for (const p of flecks.parts) {
        p.vy += 900 * dt; p.vx *= Math.pow(0.4, dt); p.x += p.vx * dt; p.y += p.vy * dt; p.spin += p.vs * dt
        const lit = Math.abs(Math.cos(p.spin))
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.spin * 0.4); ctx.scale(Math.max(0.15, lit), 1)
        ctx.globalAlpha = Math.min(1, (1 - p.life / p.span) * 2.5)
        ctx.fillStyle = p.white || lit > 0.92 ? '#ffffff' : p.color
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
        ctx.restore()
      }
      flecks.raf = flecks.parts.length && s.open ? requestAnimationFrame(tick) : 0
    }
    flecks.raf = requestAnimationFrame(tick)
  }
  const fleckStop = () => { cancelAnimationFrame(flecks.raf); flecks.raf = 0; flecks.parts = []; flecks.ctx?.clearRect(0, 0, flecks.w, flecks.h) }

  // Particles on one canvas: a burst when the card lands, then a slow sparkle while the card is shown.
  const fx = { raf: 0, ctx: null, w: 0, h: 0, parts: [], ambient: [], color: '#ffffff' }
  function fxRun() {
    if (fx.raf) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    fx.w = innerWidth; fx.h = innerHeight; s.burst.width = fx.w * dpr; s.burst.height = fx.h * dpr
    fx.ctx = s.burst.getContext('2d'); fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    let last = performance.now()
    const tick = now => {
      const dt = Math.min(0.05, (now - last) / 1000), f = dt * 60, ctx = fx.ctx; last = now
      ctx.clearRect(0, 0, fx.w, fx.h)
      for (const p of fx.ambient) {
        p.y -= p.speed * dt; p.phase += dt * p.sway
        if (p.y < -20) { p.y = fx.h + 20; p.x = Math.random() * fx.w }
        const a = p.alpha * (0.55 + 0.45 * Math.sin(p.phase * 1.7)) * Math.min(1, p.age += dt)
        const x = p.x + Math.sin(p.phase) * 14
        const g = ctx.createRadialGradient(x, p.y, 0, x, p.y, p.r)
        g.addColorStop(0, p.white ? 'rgba(255,255,255,1)' : fx.color); g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.globalAlpha = a; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, p.y, p.r, 0, Math.PI * 2); ctx.fill()
      }
      fx.parts = fx.parts.filter(p => (p.life -= dt / p.span) > 0)
      for (const p of fx.parts) {
        p.vx *= Math.pow(0.975, f); p.vy = p.vy * Math.pow(0.975, f) + 0.18 * f; p.x += p.vx * f; p.y += p.vy * f
        ctx.globalAlpha = Math.min(1, p.life * 1.4); ctx.strokeStyle = ctx.fillStyle = p.white ? '#ffffff' : fx.color
        if (p.spark) { ctx.lineWidth = p.size * 0.6; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2); ctx.stroke() }
        else { ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * p.life), 0, Math.PI * 2); ctx.fill() }
      }
      ctx.globalAlpha = 1
      fx.raf = s.open ? requestAnimationFrame(tick) : 0
    }
    fx.raf = requestAnimationFrame(tick)
  }
  const fxStop = () => { cancelAnimationFrame(fx.raf); fx.raf = 0; fx.parts = []; fx.ambient = []; fx.ctx?.clearRect(0, 0, fx.w, fx.h) }
  function fxBurst(rarity) {
    if (reducedMotion()) return
    fx.color = RARITY_COLOR[rarity.key]
    const r = s.card.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height * 0.45
    const count = { common: 30, rare: 90, epic: 150, legendary: 260 }[rarity.key], power = { common: 6, rare: 10, epic: 13, legendary: 17 }[rarity.key]
    // from the card's edge outwards: the card sits in front, so the burst reads as a halo breaking out from behind it
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, v = (0.45 + Math.random() * 0.55) * power, ex = Math.cos(a), ey = Math.sin(a)
      fx.parts.push({ x: cx + ex * r.width * 0.42, y: cy + ey * r.height * 0.4, vx: ex * v, vy: ey * v - power * 0.3,
        size: 1.6 + Math.random() * 3.4, life: 1, span: 1.1 + Math.random() * 1, spark: Math.random() < 0.45, white: Math.random() < 0.3 })
    }
    fxRun()
  }
  function fxAmbient(rarity) {
    if (reducedMotion()) return
    fx.color = RARITY_COLOR[rarity.key]
    const count = { common: 16, rare: 26, epic: 38, legendary: 56 }[rarity.key]
    fx.ambient = Array.from({ length: count }, () => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: 2 + Math.random() * 7,
      speed: 8 + Math.random() * 20, sway: 0.4 + Math.random() * 0.8, phase: Math.random() * 6.28, alpha: 0.12 + Math.random() * 0.35, white: Math.random() < 0.25, age: 0 }))
    fxRun()
  }

  function fillCard(spin, packMicro) {
    const rarity = rarityOf(spin.multiplierBps), paid = BigInt(spin.paidMicro), bonus = BigInt(spin.bonusMicro)
    const face = {
      rarityName: rarity.name,
      multiplier: times(spin.multiplierBps),
      total: money(paid + bonus),
      split: bonus > 0n ? `${money(paid)} paid + ${money(bonus)} bonus` : `${money(paid)} paid · full value`,
      foot: `${PACK_NAMES[Number(packMicro) / 1_000_000] ?? 'Credit'} pack · #${String(spin.id).slice(0, 8)}`,
    }
    s.card.className = `stage-card is-${rarity.key}`
    root.dataset.rarity = rarity.key
    q('.card-rarity').textContent = face.rarityName
    q('.card-mult').textContent = face.multiplier
    q('.card-total').textContent = face.total
    q('.card-split').textContent = face.split
    q('.card-foot').textContent = face.foot
    s.glCard?.setFront(face, rarity.key)
    return { rarity, total: face.total }
  }

  async function prepare(price) {
    s.price = price; s.tearing = false; s.tearAt = 0; s.tearP = 0; s.shed = 0
    root.dataset.tier = String(price)
    delete root.dataset.rarity
    root.className = 'pack-stage is-waiting'
    root.classList.toggle('is-css', !s.glBody)
    s.actions.hidden = true; s.hide.hidden = true
    s.card.className = 'stage-card'
    if (s.glBody) { const label = await labelFor(price); s.glBody.setLabel(label); s.glStrip.setLabel(label) }
    if (s.glBody && s.glCard === undefined) {
      // undefined: not tried yet; null: no WebGL card here (or its context was lost), so the CSS card is used
      const toCss = () => { s.glCard = null; root.classList.remove('has-glcard') }
      const [cat, mark, wordmark] = await Promise.all([loadCat(), loadImage('/credits/repoing-mark.png'), loadImage('/credits/repoing-wordmark.png')])
      try { s.glCard = createCard(q('.card-gl'), { cat, mark, wordmark }, { onLost: toCss }) } catch { s.glCard = null }
    }
    root.classList.toggle('has-glcard', Boolean(s.glCard))
  }
  function close(focusBack) {
    s.open = false
    root.classList.remove('is-open')
    root.hidden = true
    cancelAnimationFrame(frame); frame = 0
    fxStop(); fleckStop()
    if (focusBack && returnFocus?.focus) returnFocus.focus()
  }
  return {
    get isOpen() { return s.open },
    /** Shows the pack waiting (shaking), with a status line. */
    open(price, status) {
      s.status.textContent = status
      if (s.open) return s.ready
      returnFocus = document.activeElement
      s.open = true
      s.ready = prepare(price).then(() => {
        if (!s.open) return
        root.hidden = false
        frame = requestAnimationFrame(draw)
        requestAnimationFrame(() => root.classList.add('is-open'))
      }).catch(() => { s.open = false })
      return s.ready
    },
    status(text, { canHide = false } = {}) { s.status.textContent = text; s.hide.hidden = !canHide },
    close() { close(true) },
    /** Tears the pack and reveals a checked spin ({ id, multiplierBps, paidMicro, bonusMicro }) of a pack of packMicro. */
    async reveal(spin, packMicro) {
      if (s.ready) await s.ready
      if (!s.open) return
      s.hide.hidden = true
      const { rarity, total } = fillCard(spin, packMicro)
      try { await animate(rarity) } catch (error) { if (error === CLOSED) return; throw error }
      if (!s.open) return
      const chip = document.createElement('span'), amount = document.createElement('span')
      chip.className = 'stage-chip'; chip.textContent = `${rarity.name} · ${times(spin.multiplierBps)}`
      amount.textContent = `${total} of AI credits`
      s.status.replaceChildren(chip, amount)
      s.actions.hidden = false
      q('.stage-done').focus()
    },
    destroy() {
      close(false)
      s.glBody?.release(); s.glStrip?.release(); s.glCard?.release?.()
      root.remove()
    },
  }
  // The tear, the pull, the charge and the flip; the reduced-motion stage shows the card at once.
  async function animate(rarity) {
    if (reducedMotion()) {
      s.glCard?.settle()
      root.className = 'pack-stage is-open is-revealed is-settled is-still'
      root.classList.toggle('is-css', !s.glBody)
      root.classList.toggle('has-glcard', Boolean(s.glCard))
    } else {
      // each step stops if the stage was closed (or the page left) meanwhile
      const step = async (cls, ms, status) => { if (!s.open) throw CLOSED; if (status) s.status.textContent = status; root.classList.add(cls); await wait(ms) }
      s.tearing = true; s.tearP = 0; s.tearAt = performance.now() + GRIP_MS
      root.classList.remove('is-waiting')
      try { navigator.vibrate?.([6, 40, 8, 30, 6, 60, 12]) } catch { /* no vibration here */ }
      await step('is-tearing', GRIP_MS + TEAR_MS + 160, 'Tearing it open…')
      await step('is-rising', 680, 'Pulling out your card…')
      await step('is-pulled', 360)
      await step('is-out', 760)
      await step('is-charging', 720, 'Revealing…')
      if (!s.open) return
      root.classList.add('is-revealed')
      // the flip ends on the card's own clock; a lost GPU context or a closed stage must not hold the reveal
      const flipped = Promise.race([s.glCard ? s.glCard.flip() : wait(780), wait(1600)])
      await wait(320)                                     // the card is edge-on: the flash and the burst
      if (!s.open) return
      fxBurst(rarity)
      await flipped
      if (!s.open) return
      root.classList.add('is-settled')
      fxAmbient(rarity)
    }
  }
}
