#!/usr/bin/env node
// One-time, READ-ONLY snapshot of the public mainnet accounts the LEGACY stack's bridged flows need (the bridge program's
// code, its config, native wrapper and SOL vault, and the bridged-SOL quote mint A49o), so the local validator runs the
// production bridge code without touching mainnet at test time:
//   node scripts/e2e/hooks-native/snapshot-bridge.mjs [RPC_URL]   (default https://api.mainnet-beta.solana.com)
// It calls getGenesisHash (must be mainnet-beta) and one getMultipleAccountsInfo, nothing else: no keys, no sends.
// Output: tests/e2e/hooks-native/snapshot/bridge.json (public account data, sha256 per account, no patches applied; the
// stack applies its one documented patch, the program data's deploy slot, when it loads the snapshot).
import { mkdirSync, writeFileSync } from 'node:fs'
import { Connection, PublicKey } from '@solana/web3.js'
import { derivedAddresses, MAINNET_GENESIS, PROGRAMS, QUOTE_MINT } from '../../../src/hooklab-owner-driver/pins.mjs'
import { REPO_ROOT, sha256 } from './common.mjs'

const rpc = process.argv[2] ?? 'https://api.mainnet-beta.solana.com'
const connection = new Connection(rpc, { commitment: 'finalized', disableRetryOnRateLimit: true })
if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw Error('not mainnet-beta; refusing to snapshot')
const d = derivedAddresses(PROGRAMS)
const roles = { 'bridge-program-data': d.bridgeProgramData, 'bridge-config': d.bridgeConfig, 'bridge-native-wrapper': d.bridgeNativeWrapper,
  'bridge-sol-vault': d.bridgeSolVault, 'quote-mint': QUOTE_MINT }
const { context, value } = await connection.getMultipleAccountsInfoAndContext(Object.values(roles).map(a => new PublicKey(a)), 'finalized')
const accounts = Object.entries(roles).map(([role, address], i) => {
  const info = value[i]
  if (!info) throw Error(`${role} ${address} missing on mainnet`)
  const data = Buffer.from(info.data)
  return { role, address, owner: info.owner.toBase58(), lamports: String(info.lamports), executable: info.executable, sha256: sha256(data), dataBase64: data.toString('base64') }
})
const out = { schema: 'repoing/e2e-public-mainnet-snapshot/1', purpose: 'the production bridge and bridged-SOL mint for the local legacy stack',
  source: { cluster: 'mainnet-beta', genesisHash: MAINNET_GENESIS, slot: context.slot, commitment: 'finalized', fetchedAt: new Date().toISOString() },
  patches: [], bridgeProgram: PROGRAMS.bridge, accounts }
mkdirSync(`${REPO_ROOT}tests/e2e/hooks-native/snapshot`, { recursive: true })
writeFileSync(`${REPO_ROOT}tests/e2e/hooks-native/snapshot/bridge.json`, `${JSON.stringify(out, null, 1)}\n`)
console.log(`bridge snapshot at slot ${context.slot}: ${accounts.map(a => `${a.role} ${a.sha256.slice(0, 12)}`).join(', ')}`)
