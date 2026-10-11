import { creditsPacksSettings } from '../../src/credits-packs.mjs'
import { creditsKeysSettings } from '../../src/credits-keys.mjs'
import { database } from './server.mjs'

// Web side of AI credit packs (src/credits-packs.mjs): the /credits page, its route and its GitHub sign-in answer 404 (or
// do not finish) unless the packs are switched on and the database and the GitHub App secret (which seals the credit
// service's session cookie) are configured.
export const creditPacksAvailable = () => creditsPacksSettings() !== null && Boolean(database()) && Boolean(process.env.GITHUB_APP_CLIENT_SECRET)
// The keys section on /credits (src/credits-keys.mjs) is on with the packs, and off for a bad AI gateway origin. Pages that link to
// /credits#keys (the claim card after a conversion) ask this, so the link never leads to a 404.
export const creditKeysAvailable = () => creditPacksAvailable() && creditsKeysSettings() !== null
