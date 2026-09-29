import { ACTIONS_JSON, actionJson, actionOptions } from '../lib/solana-actions.mjs'

// Solana Actions discovery file: Blink clients read it cross-origin to map /token/<mint> to the buy action.
export const dynamic = 'force-static'
export function GET() { return actionJson(ACTIONS_JSON, { cache: 'public, max-age=3600' }) }
export function OPTIONS() { return actionOptions() }
