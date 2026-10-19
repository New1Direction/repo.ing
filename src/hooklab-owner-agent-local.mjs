// Local-acceptance mode for the owner agent (scripts/hooklab-owner-agent.mjs --local-acceptance): the same agent code,
// but the admin is a DISPOSABLE key file on a local validator, for the e2e suite. It never reaches mainnet: the site origin
// and both RPCs must be loopback, both RPCs must report the same non-mainnet genesis, the production admin is refused,
// and the agent's ledgers live in an explicit state directory instead of ~/.hooklab-owner.
import path from 'node:path'
import { Keypair } from '@solana/web3.js'
import { MAINNET_GENESIS } from './hooklab-owner-driver/pins.mjs'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const need = (ok, message) => { if (!ok) throw Error(`Owner agent local acceptance refused: ${message}`) }

/**
 * @param {{ origin: string, rpcs: string[], connections: { getGenesisHash(): Promise<string> }[], adminKeyText: string,
 *   stateDir: string | undefined, mainnetAdmin: string }} input
 * @returns {Promise<{ adminAddress: string, genesisHash: string, stateDir: string }>}
 */
export async function localAgentSettings({ origin, rpcs, connections, adminKeyText, stateDir, mainnetAdmin }) {
  const site = new URL(origin)
  need(site.protocol === 'https:' && LOOPBACK.has(site.hostname) && site.pathname === '/' && !site.username && !site.password && !site.search && !site.hash,
    'the site must be an exact HTTPS loopback origin')
  need(rpcs.length === 2 && rpcs.every(url => LOOPBACK.has(new URL(url).hostname)), 'both RPCs must be loopback RPC endpoints')
  need(typeof stateDir === 'string' && path.isAbsolute(stateDir), 'an absolute state directory is required (never ~/.hooklab-owner)')
  let bytes
  try { bytes = Uint8Array.from(JSON.parse(adminKeyText)) } catch { bytes = new Uint8Array() }
  need(bytes.length === 64, 'the admin key file must hold a 64-byte keypair array')
  const adminAddress = Keypair.fromSecretKey(bytes).publicKey.toBase58()
  bytes.fill(0)
  need(adminAddress !== mainnetAdmin, 'the production admin key never runs in local acceptance')
  const hashes = await Promise.all(connections.map(connection => connection.getGenesisHash()))
  need(hashes.length === 2 && hashes[0] === hashes[1], 'the two RPCs report different genesis hashes')
  need(hashes[0] !== MAINNET_GENESIS, 'local acceptance refuses the mainnet genesis')
  return { adminAddress, genesisHash: hashes[0], stateDir }
}
