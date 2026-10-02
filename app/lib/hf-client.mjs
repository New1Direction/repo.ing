import { createHfClient } from '../../src/hf-api.mjs'

// One anonymous Hugging Face client per web process, so its pacing (the Hub's RateLimit headers) covers every request.
// Tests may set globalThis.__repoingHfClient to a client pointed at tests/fixtures/hf-server.mjs.
export function hfClient() {
  globalThis.__repoingHfClient ??= createHfClient()
  return globalThis.__repoingHfClient
}
