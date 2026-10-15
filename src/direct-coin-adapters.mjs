import { Connection, PublicKey } from '@solana/web3.js'
import { DEVNET_PROGRAM_ID } from '@raydium-io/raydium-sdk-v2'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
import { DEVNET_GENESIS, DIRECT_VENUES, HOOK_LAB_INTEGRATION_COMMIT, HOOK_LAB_MANIFEST_SHA256, previewDirectCoin } from './direct-coins.mjs'

const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
export class DirectCoinError extends Error {
  constructor(message, status = 422) { super(message); this.status = status }
}

export function directCoinConnection() {
  return new Connection(process.env.DIRECT_COINS_DEVNET_RPC_URL || 'https://api.devnet.solana.com', {
    commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
  })
}

// All adapters share a read-only contract. Do not use the public Bordrless SDK for the private fork.
export function directCoinAdapter(id) {
  if (!Object.hasOwn(DIRECT_VENUES, id)) throw new DirectCoinError('Unknown adapter.')
  const venue = DIRECT_VENUES[id]
  const sdkId = id === 'raydium' ? DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM
    : id === 'meteora-dbc' ? DYNAMIC_BONDING_CURVE_PROGRAM_ID : id === 'meteora-damm' ? CP_AMM_PROGRAM_ID : null
  if (sdkId && sdkId.toBase58() !== (venue.programs.launch || venue.programs.dex)) throw new DirectCoinError('SDK program identity drift. Adapter disabled.', 503)
  return {
    capabilities: { ...venue, canBuild: false, canSimulate: false, canSubmit: false },
    preview(input) {
      if (input.adapter !== id) throw new DirectCoinError('Adapter mismatch.')
      return previewDirectCoin(input)
    },
    async inspect(input, { confirmedNetwork, connection = directCoinConnection() } = {}) {
      const preview = this.preview(input)
      if (confirmedNetwork !== 'devnet') throw new DirectCoinError('Explicit devnet confirmation is required.')
      if (!preview.compatible) throw new DirectCoinError(preview.refusals.join(' '))
      if (id === 'hooklab') {
        // Lazy Node-only boundary: a broken native artifact must not disable Standard Coin.
        const { inspectHookLabRecipe } = await import('./hook-lab-preflight.mjs')
        const { createHookLabRecipe } = await import('./hook-lab-recipe.mjs')
        const plan = preview.plan
        const envelope = createHookLabRecipe({ format: 'hook-lab/1', coin: { name: plan.name, ticker: plan.symbol }, blocks: [] }, 'plain')
        const { inspection, intent: observedIntent } = await inspectHookLabRecipe(envelope, connection, confirmedNetwork)
        const intentRefusals = plan.creatorFeeBps === null ? ['Enter an explicit zero creator fee; no fee is inferred.'] : []
        const intent = intentRefusals.length ? null : observedIntent
        return { network: 'devnet', slot: inspection.observedSlot, checkedAt: new Date().toISOString(),
          status: inspection.refusals.some(r => r.subject === 'rpc') ? 'unavailable' : inspection.refusals.length ? 'refused' : 'programs-present',
          warnings: observedIntent.warnings, programs: inspection.programs,
          native: { deliveryCommit: HOOK_LAB_INTEGRATION_COMMIT, manifestSha256: HOOK_LAB_MANIFEST_SHA256,
            capabilities: { plainOnly: true, canBuild: false, canSubmit: false }, inspection, intent, intentRefusals },
          canSubmit: false, simulation: preview.simulation }
      }
      if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new DirectCoinError('RPC genesis is not Solana devnet. Refusing inspection.')
      const entries = Object.entries(venue.programs)
      const { context, value } = await connection.getMultipleAccountsInfoAndContext(entries.map(([, address]) => new PublicKey(address)))
      const programs = await Promise.all(entries.map(async ([name, address], index) => {
        const account = value[index]
        const result = { name, address, executable: account?.executable === true, owner: account?.owner?.toBase58() ?? null,
          programData: null, upgradeAuthority: null, authorityStatus: 'unknown' }
        if (!result.executable) return result
        if (account.owner.equals(loader) && account.data.length === 36 && account.data.readUInt32LE(0) === 2) {
          const programData = new PublicKey(account.data.subarray(4, 36))
          result.programData = programData.toBase58()
          const data = await connection.getAccountInfo(programData, { commitment: 'confirmed', minContextSlot: context.slot })
          if (data?.owner.equals(loader) && data.data.length >= 45 && data.data.readUInt32LE(0) === 3 && [0, 1].includes(data.data[12])) {
            result.upgradeAuthority = data.data[12] === 1 ? new PublicKey(data.data.subarray(13, 45)).toBase58() : null
            result.authorityStatus = result.upgradeAuthority ? 'upgradeable' : 'immutable'
          }
        }
        return result
      }))
      const warnings = ['Account reads only: no binary hash verification, config approval, transaction simulation or launch readiness.']
      if (programs.some(p => !p.executable)) warnings.push('One or more required executable programs are missing.')
      if (programs.some(p => p.authorityStatus === 'unknown')) warnings.push('One or more upgrade authorities could not be determined.')
      return { network: 'devnet', genesis: DEVNET_GENESIS, slot: context.slot, checkedAt: new Date().toISOString(), programs, warnings,
        status: programs.every(p => p.executable) ? 'programs-present' : 'missing-programs', canSubmit: false, simulation: preview.simulation }
    },
    buildTransaction() { throw new DirectCoinError('Transaction generation is disabled. No live-chain action is authorized.', 403) },
  }
}
