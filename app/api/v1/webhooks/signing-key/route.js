import { apiHeaders, apiJson, apiNoStore, apiOptions } from '../../../../lib/public-api.mjs'
import { publicSigningKey, webhooksEnabled } from '../../../../../src/launch-webhooks.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The Ed25519 public key that verifies webhook deliveries (docs/MARKET_DATA_API.md#webhooks): each delivery's x-repoing-signature is
// "ed25519=" + base64 of the signature over `${x-repoing-timestamp}.${raw body}`.
export const OPTIONS = apiOptions
export function GET() {
  const key = webhooksEnabled() ? publicSigningKey() : null
  if (!key) return apiJson({ error: 'Webhooks are not enabled' }, { status: 404, headers: apiNoStore })
  return apiJson({ ...key, signed: '`${x-repoing-timestamp}.${raw body}`', header: 'x-repoing-signature: ed25519=<base64>' }, { headers: apiHeaders(3600) })
}
