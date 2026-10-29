import { timingSafeEqual } from 'node:crypto'

const failure = (message, status) => Object.assign(Error(message), { status })

// Preview bypass is explicit and restricted to local/Amp hosts, never repo.ing.
// Public mode requires both human verification and an authenticated reverse proxy.
export function neuronBotConfiguration(env = process.env) {
  if (env.NEURONS_PUBLISHING_ENABLED !== 'true') return null
  const origin = new URL(env.HOOK_WALLET_IDENTITY_ORIGIN)
  if (env.NEURONS_PREVIEW_ONLY === 'true') {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.hostname.endsWith('.onamp.dev')) throw failure('Preview bypass is restricted to local preview hosts.', 503)
    return null
  }
  const siteKey = env.NEURONS_TURNSTILE_SITE_KEY, secret = env.NEURONS_TURNSTILE_SECRET_KEY, edgeSecret = env.NEURONS_EDGE_SECRET
  if (origin.protocol !== 'https:' || origin.origin !== env.HOOK_WALLET_IDENTITY_ORIGIN
    || !siteKey || !secret || !edgeSecret || edgeSecret.length < 32 || edgeSecret.length > 256
    || siteKey === secret || secret === edgeSecret
    // Cloudflare's published dummy keys must never unlock public publishing.
    || /^[123]x0{10,}/.test(siteKey) || /^[123]x0{10,}/.test(secret)) throw failure('Public bot protection is not configured.', 503)
  return { siteKey, secret, edgeSecret, hostname: origin.hostname }
}

export function assertNeuronEdge(request, env = process.env) {
  const config = neuronBotConfiguration(env)
  if (!config) return null
  const provided = Buffer.from(request.headers.get('x-neuron-edge-secret') ?? '')
  const expected = Buffer.from(config.edgeSecret)
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw failure('Use the protected public site.', 403)
  return config
}

export async function verifyNeuronBot(request, config, action, fetcher = fetch) {
  if (!config) return
  const token = request.headers.get('x-neuron-bot-token')
  if (!token || token.length > 2048) throw failure('Complete the security check and try again.', 403)
  let value
  try {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: config.secret, response: token }),
      signal: AbortSignal.timeout(5000), redirect: 'error',
    })
    if (!response.ok) throw Error('Siteverify unavailable')
    value = await response.json()
  } catch { throw failure('Security verification is unavailable. Try again later.', 503) }
  // Siteverify enforces five-minute expiry and single use; never cache success.
  if (value?.success !== true || value.hostname !== config.hostname || value.action !== action) throw failure('Security check expired or failed. Please try again.', 403)
}
