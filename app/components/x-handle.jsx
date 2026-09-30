import { XHandleLink } from './x-handle-link'
import { xHandleFor } from '../lib/x-links.mjs'

// Server component: <XHandle wallet={…}/> renders the wallet's linked @handle, or nothing. Handles requested while one
// page renders are read in a single batched query (see createHandleLoader), then cached briefly.
export async function XHandle({ wallet, ...props }) {
  let link = null
  try { link = await xHandleFor(wallet) } catch { link = null }
  return <XHandleLink link={link} {...props}/>
}
