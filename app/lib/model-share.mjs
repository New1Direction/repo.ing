import { SITE_ORIGIN, X_HANDLE, tokenPageUrl } from './share-links.mjs'
import { HF_DISCLAIMER_SHORT } from '../../src/hf-copy.mjs'
import { isHfModelPath } from '../../src/hf-url.mjs'

// The launch kit's announcement for a Hugging Face model market (app/lib/builder-share.mjs is the repository one). It
// always carries the short disclaimer: a community launch, not endorsed by the creators, not affiliated with Hugging Face.
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function modelLaunchPostText({ symbol, path }) {
  const ticker = /^[A-Z0-9]{1,10}$/.test(String(symbol ?? '')) ? `$${symbol} is live: ` : ''
  return `${ticker}I just launched a community market for ${path} on repo.ing (@${X_HANDLE}). Every trade pays the model's owner in SOL. ${HF_DISCLAIMER_SHORT}`
}

export function modelLaunchPostUrl({ mint, symbol, path, origin = SITE_ORIGIN, ref = null }) {
  if (!MINT.test(String(mint ?? '')) || !isHfModelPath(path)) return null
  const query = new URLSearchParams({ text: modelLaunchPostText({ symbol, path }), url: tokenPageUrl(mint, origin, ref) })
  return `https://x.com/intent/post?${query}`
}
