import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMarketConfigResolver } from './market-config.mjs'
import { createLaunchEvidenceVerifier } from './launch-evidence.mjs'
import { RECOVERED_LAUNCH_CONFIG, RECOVERED_LAUNCH_CONFIG_SHA256 } from './launch-custody.mjs'
import { MULTISIG_VAULT } from './custody-multisig.mjs'
import { DBC_PROGRAM_ID } from './launch-fee-config.mjs'

// Preparation only: no router import, allowlist mutation, DB write, signing or execution capability.
// A successful identity review is not trading enablement, spending approval or beneficiary authorization.
export function createNewMarketAdmissionReview({ connections }) {
  if (connections?.length !== 2 || new URL(connections[0].rpcEndpoint).hostname === new URL(connections[1].rpcEndpoint).hostname) {
    throw Error('Two independently operated RPC providers are required')
  }
  const resolve = createMarketConfigResolver(RECOVERED_LAUNCH_CONFIG, [], null)
  const verifiers = connections.map(connection => createLaunchEvidenceVerifier({ connection, config: RECOVERED_LAUNCH_CONFIG }))
  const coder = new DynamicBondingCurveClient(connections[0], 'finalized').state.program.coder.instruction
  const denied = () => ({ state: 'denied', tradingEnabled: false })
  return async market => {
    try {
      const repoId = String(market.githubRepoId)
      if (!/^[1-9]\d{0,17}$/.test(repoId) || market.status !== 'confirmed' || market.indexedAt == null ||
          market.launchFinality !== 'finalized' || market.launchSlot == null || market.creatorWallet !== MULTISIG_VAULT ||
          market.quoteMint || market.quoteAssetId || market.bundleId != null || market.transferHookProgram || market.earlyAccessEnd) return denied()
      resolve(market) // Derive mint/pool against only the safe config; never inherit the historical config list.
      const pair = await Promise.all(connections.map(async (connection, i) => {
        const [config, receipt, evidence] = await Promise.all([
          connection.getAccountInfo(new PublicKey(RECOVERED_LAUNCH_CONFIG), 'finalized'),
          connection.getTransaction(market.launchSignature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }),
          verifiers[i](market),
        ])
        if (!config?.owner.equals(DBC_PROGRAM_ID) || createHash('sha256').update(config.data).digest('hex') !== RECOVERED_LAUNCH_CONFIG_SHA256 ||
            !receipt?.meta || receipt.meta.err !== null || !Array.isArray(receipt.meta.preBalances) || !Array.isArray(receipt.meta.postBalances) ||
            receipt.transaction.signatures[0] !== market.launchSignature || evidence.state !== 'match' || evidence.finality !== 'finalized' ||
            String(evidence.slot) !== String(market.launchSlot) || String(receipt.slot) !== String(market.launchSlot)) throw Error('Admission evidence differs')
        const message = receipt.transaction.message, keys = message.accountKeys
        const creation = message.instructions.map(ix => keys[ix.programIdIndex].equals(DBC_PROGRAM_ID) ? coder.decode(ix.data, 'base58') : null)
          .filter(ix => ix?.name === 'initializeVirtualPoolWithSplToken')
        if (creation.length !== 1 || creation[0].data.params.uri !== `https://repo.ing/m/${repoId}`) throw Error('Repository metadata differs')
        return { evidence, transaction: receipt.transaction, meta: receipt.meta }
      }))
      if (!isDeepStrictEqual(pair[0], pair[1])) return denied()
      return { state: 'eligible-for-review', tradingEnabled: false, repoId, mint: market.mint, pool: market.pool,
        config: RECOVERED_LAUNCH_CONFIG, creator: MULTISIG_VAULT, launchSlot: String(market.launchSlot) }
    } catch { return denied() }
  }
}
