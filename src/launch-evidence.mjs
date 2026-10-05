import bs58 from 'bs58'
import { createQuoteAwareConfigResolver, readPoolConfig } from './market-config.mjs'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getTransferHook, unpackMint } from '@solana/spl-token'
import { ActivationType, DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { usesActivationClock } from './launch-clock.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID, decodeMintConfig, earlyAccessAddresses } from './early-access-hook.mjs'
import { earlyAccessDbcConfig, isEarlyAccessMarket } from './early-access.mjs'

const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
// SDK 1.5.13 IDL: initializeVirtualPoolWithSplToken.
const CREATE_SPL_POOL_DISCRIMINATOR = Buffer.from([140, 85, 215, 176, 102, 54, 104, 79])
// SDK 1.5.13 IDL: initializeVirtualPoolWithToken2022TransferHook (config 0, creator 2, base mint 3, pool 5, hook program 8, payer 9).
const CREATE_HOOK_POOL_DISCRIMINATOR = Buffer.from([182, 13, 233, 177, 42, 145, 135, 2])

// DBC initializes activationPoint from the on-chain Clock. Swap events use that same clock; the RPC's estimated blockTime can
// differ by seconds.
function launchEvidence(market, transaction, state, fixed) {
  const activationClock = usesActivationClock(market)
  const timestamp = activationClock ? Number(state.poolState.activationPoint.toString()) : transaction.blockTime
  if (activationClock && (fixed?.activationType !== ActivationType.Timestamp || !Number.isSafeInteger(timestamp) || timestamp <= 0)) {
    return { state: 'unavailable', reason: 'Finalized DBC launch timestamp is unavailable' }
  }
  return { state: 'match', slot: BigInt(transaction.slot), finality: 'finalized',
    blockTime: Number.isInteger(timestamp) ? new Date(timestamp * 1000) : null }
}

// earlyAccessConfig: EARLY_ACCESS_DBC_CONFIG (read when an early access market is verified), or the address itself.
export function createLaunchEvidenceVerifier({ connection, config, earlyAccessConfig = () => earlyAccessDbcConfig() }) {
  // SOL markets on the approved configs; a stock-paired market only on its stock's config (docs/STOCK_QUOTES.md).
  const resolveConfig = createQuoteAwareConfigResolver(config)
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const verifyEarlyAccess = earlyAccessVerifier({ connection, dbc, earlyAccessConfig })
  return async function verify(market) {
    if (isEarlyAccessMarket(market)) return verifyEarlyAccess(market)
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
        usesActivationClock(market) || market.quoteMint ? readPoolConfig(dbc, configKey) : null,
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
    if (market.quoteMint && (!fixed || !fixed.quoteMint.equals(new PublicKey(market.quoteMint)))) {
      return { state: 'mismatch', reason: 'Stock config does not quote the recorded stock mint' }
    }
    if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) || !state.poolState.config.equals(configKey) ||
        !state.poolState.baseMint.equals(mint) || !state.poolState.creator.equals(creator)) {
      return { state: 'mismatch', reason: 'Finalized pool or mint account contradicts recorded launch' }
    }
    return launchEvidence(market, transaction, state, fixed)
  }
}

// An early access launch (v0, with its lookup table): DBC's transfer-hook pool creation on the early access config by the
// recorded creator, mint, pool and launcher (payer), with our hook program; a Token-2022 mint whose transfer hook is ours (or,
// once the curve is full, the default key DBC sets it to); and the hook's own mint config holding this repository and exactly
// the stamped window end.
function earlyAccessVerifier({ connection, dbc, earlyAccessConfig }) {
  const hook = EARLY_ACCESS_HOOK_PROGRAM_ID
  return async function verifyEarlyAccess(market) {
    if (!market.mint || !market.pool || !market.launchSignature) {
      return { state: 'incomplete', reason: 'Mint, pool, or launch signature is absent' }
    }
    let mint, pool, creator, launcher, end
    try {
      mint = new PublicKey(market.mint)
      pool = new PublicKey(market.pool)
      creator = new PublicKey(market.creatorWallet)
      launcher = new PublicKey(market.launcherWallet)
      end = new Date(market.earlyAccessEnd).getTime()
      if (bs58.decode(market.launchSignature).length !== 64 || !Number.isSafeInteger(end)) throw Error('stamp')
    } catch {
      return { state: 'invalid', reason: 'Malformed mint, pool, wallet, signature or early access window' }
    }
    let configKey
    try {
      const value = typeof earlyAccessConfig === 'function' ? earlyAccessConfig() : earlyAccessConfig
      configKey = new PublicKey(value)
      if (market.transferHookProgram !== hook.toBase58() || market.quoteMint || market.quoteAssetId) throw Error('stamp')
      if (!deriveDbcPoolAddress(NATIVE_MINT, mint, configKey).equals(pool)) throw Error('pool')
    } catch {
      return { state: 'mismatch', reason: 'Recorded pool is not the DBC pool derived from mint and the early access config' }
    }
    let transaction, state, mintInfo, fixed, hookConfig
    try {
      [transaction, state, mintInfo, fixed, hookConfig] = await Promise.all([
        connection.getTransaction(market.launchSignature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }),
        dbc.state.getPool(pool),
        connection.getAccountInfo(mint, 'finalized'),
        usesActivationClock(market) ? readPoolConfig(dbc, configKey) : null,
        connection.getAccountInfo(earlyAccessAddresses(mint, hook).config, 'finalized'),
      ])
    } catch (error) {
      return { state: 'unavailable', reason: `Solana RPC verification failed: ${error.message}` }
    }
    if (!transaction) return { state: 'unavailable', reason: 'Finalized launch transaction is not available from this RPC' }
    if (transaction.meta?.err) return { state: 'invalid', reason: 'Recorded launch transaction failed' }
    const message = transaction.transaction.message
    let keys
    try { keys = message.getAccountKeys({ accountKeysFromLookups: transaction.meta?.loadedAddresses }).keySegments().flat() }
    catch { return { state: 'invalid', reason: 'Launch transaction accounts could not be read' } }
    const isKey = (index, expected) => keys[index]?.equals(expected)
    const createInstruction = message.compiledInstructions.find(ix => isKey(ix.programIdIndex, DBC_PROGRAM) &&
      Buffer.from(ix.data).subarray(0, 8).equals(CREATE_HOOK_POOL_DISCRIMINATOR) && isKey(ix.accountKeyIndexes[0], configKey) &&
      isKey(ix.accountKeyIndexes[2], creator) && isKey(ix.accountKeyIndexes[3], mint) && isKey(ix.accountKeyIndexes[5], pool) &&
      isKey(ix.accountKeyIndexes[8], hook) && isKey(ix.accountKeyIndexes[9], launcher))
    const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures)
    if (!createInstruction || ![creator, mint, launcher].every(key => signers.some(signer => signer.equals(key)))) {
      return { state: 'mismatch', reason: 'Launch signature is not a DBC transfer-hook pool creation by the recorded accounts' }
    }
    if (!state || !mintInfo || !hookConfig) return { state: 'missing', reason: 'Finalized DBC pool, Token-2022 mint or early access mint config is missing' }
    if (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) || !state.poolState.config.equals(configKey) ||
        !state.poolState.baseMint.equals(mint) || !state.poolState.creator.equals(creator)) {
      return { state: 'mismatch', reason: 'Finalized pool or mint account contradicts recorded launch' }
    }
    let mintHook = null, window = null
    try { mintHook = getTransferHook(unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID))?.programId ?? null } catch {}
    const curveFull = Number(state.poolState.migrationProgress) >= 1
    if (!mintHook || !(mintHook.equals(hook) || (curveFull && mintHook.equals(PublicKey.default)))) {
      return { state: 'mismatch', reason: 'Mint transfer hook is not the early access program' }
    }
    try { window = hookConfig.owner.equals(hook) ? decodeMintConfig(hookConfig.data) : null } catch {}
    if (!window || !window.mint.equals(mint) || window.repoId !== String(market.githubRepoId) || window.earlyAccessEnd * 1000 !== end) {
      return { state: 'mismatch', reason: 'Early access window on chain differs from the recorded window' }
    }
    return launchEvidence(market, transaction, state, fixed)
  }
}
