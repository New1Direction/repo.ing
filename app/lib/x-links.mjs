import { createHandleLoader, createXLinkStore, createXLinks, xConfig } from '../../src/x-links.mjs'
import { database } from './server.mjs'

export const X_STATE_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-repoing_x_oauth' : 'repoing_x_oauth'
export const X_PENDING_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-repoing_x_pending' : 'repoing_x_pending'

const config = () => { try { return xConfig() } catch (error) { console.error('X config invalid', { error: error.message }); return null } }

// Off (UI hidden, routes 404) unless both X credentials, the database and the state-sealing secret exist.
export const xLinksEnabled = () => Boolean(config() && database() && process.env.GITHUB_APP_CLIENT_SECRET)
export const xLinksConfig = () => xLinksEnabled() ? config() : null

export function xLinksService() {
  const pool = database()
  return pool ? createXLinks({ store: createXLinkStore(pool) }) : null
}

// One loader per server process: every handle requested while a page renders is read in one query, then cached 60s.
const loader = () => globalThis.__repoingXHandles ??= createHandleLoader({ loadMany: wallets => createXLinkStore(database()).byWallets(wallets) })

// wallet → { username, name, image, verified } (public link) or null. Always null while Connect X is off.
export const xHandleFor = wallet => xLinksEnabled() ? loader().load(wallet) : Promise.resolve(null)
// Map of wallet → link for any list of wallets (holder notes, tips, leaderboards, and the Parts fund backers list).
export const xHandlesFor = async wallets => xLinksEnabled() ? loader().loadMany(wallets) : new Map()
export const forgetXHandle = wallet => { globalThis.__repoingXHandles?.forget(wallet) }
