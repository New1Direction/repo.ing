import bs58 from 'bs58'
import { createMarketConfigResolver, readPoolConfig } from './market-config.mjs'
import { PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { ActivationType, DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'

const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
// SDK 1.5.13 IDL: initializeVirtualPoolWithSplToken.
const CREATE_SPL_POOL_DISCRIMINATOR = Buffer.from([140, 85, 215, 176, 102, 54, 104, 79])

export function createLaunchEvidenceVerifier({ connection, config }) {
  const resolveConfig = createMarketConfigResolver(config)
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  return async function verify(market) {
    if (!market.mint || !market.pool || !market.launchSignature) {
      return { state: 'incomplete', reason: 'Mint, pool, or launch signature is absent' }
    }
    let mint, pool, creator, launcher
    try {
      mint = new PublicKey(market.mint)
      pool = new PublicKey(market.pool)
      creator = new PublicKey(market.creatorWallet)
      launcher = new PublicKey(market.launcherWallet)
      if (bs58.decode(market.launchSignature).length !== 64) throw Error('signature length')
    } catch {
      return { state: 'invalid', reason: 'Malformed mint, pool, wallet, or signature' }
    }
    let configKey
    try { configKey = resolveConfig(market) } catch {
      return { state: 'mismatch', reason: 'Recorded pool is not the DBC pool derived from mint and fixed config' }
    }
    let transaction, state, mintInfo, fixed
    try {
      [transaction, state, mintInfo, fixed] = await Promise.all([
        connection.getTransaction(market.launchSignature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }),
        dbc.state.getPool(pool),
        connection.getAccountInfo(mint, 'finalized'),
        market.discoveryVersion ? readPoolConfig(dbc, configKey) : null,
      ])
    } catch (error) {
      return { state: 'unavailable', reason: `Solana RPC verification failed: ${error.message}` }
    }
    if (!transaction) return { state: 'unavailable', reason: 'Finalized launch transaction is not available from this RPC' }
    if (transaction.meta?.err) return { state: 'invalid', reason: 'Recorded launch transaction failed' }
    const message = transaction.transaction.message
    const keys = message.accountKeys ?? message.staticAccountKeys
    if (!keys) return { state: 'invalid', reason: 'Launch transaction has no account keys' }
    const isKey = (index, expected) => keys[index]?.equals(expected)
    const createInstruction = message.instructions?.find(ix => {
      if (!isKey(ix.programIdIndex, DBC_PROGRAM)) return false
      const discriminator = Buffer.from(bs58.decode(ix.data)).subarray(0, 8)
      return discriminator.equals(CREATE_SPL_POOL_DISCRIMINATOR) &&
        isKey(ix.accounts[0], configKey) && isKey(ix.accounts[2], creator) &&
        isKey(ix.accounts[3], mint) && isKey(ix.accounts[5], pool) &&
        isKey(ix.accounts[10], launcher)
    })
    const signers = keys.slice(0, message.header.numRequiredSignatures)
    if (!createInstruction || ![creator, mint, launcher].every(key => signers.some(signer => signer.equals(key)))) {
      return { state: 'mismatch', reason: 'Launch signature is not a DBC SPL pool creation by the recorded accounts' }
    }
    if (!state || !mintInfo) return { state: 'missing', reason: 'Finalized DBC pool or SPL mint account is missing' }
    if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) || !state.poolState.config.equals(configKey) ||
        !state.poolState.baseMint.equals(mint) || !state.poolState.creator.equals(creator)) {
      return { state: 'mismatch', reason: 'Finalized pool or mint account contradicts recorded launch' }
    }
    // DBC initializes activationPoint from the on-chain Clock. Swap events use
    // that same clock; the RPC's estimated blockTime can differ by seconds.
    const timestamp = market.discoveryVersion ? Number(state.poolState.activationPoint.toString()) : transaction.blockTime
    if (market.discoveryVersion && (fixed?.activationType !== ActivationType.Timestamp || !Number.isSafeInteger(timestamp) || timestamp <= 0)) {
      return { state: 'unavailable', reason: 'Finalized DBC launch timestamp is unavailable' }
    }
    return { state: 'match', slot: BigInt(transaction.slot), finality: 'finalized',
      blockTime: Number.isInteger(timestamp) ? new Date(timestamp * 1000) : null }
  }
}
