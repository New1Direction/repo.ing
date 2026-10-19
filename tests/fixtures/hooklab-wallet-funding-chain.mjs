// A fake two-provider mainnet for customer wallet funding (add SOL to Hook Lab, withdraw it): synthetic accounts encoded
// with the pinned production codecs, a synthetic bridge ELF through the test-only bridge pin, a test-only wallet key, and
// receipts with chosen lamport movements. Used by tests/hooklab-wallet-funding.test.mjs and the bundle-switch DB test.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import BN from 'bn.js'
import { BRIDGE_PIN, HOLDING_BYTES } from '../../src/hooklab-wallet-funding.mjs'
import { walletFundingResolver } from '../../src/hooklab-wallet-funding-resolver.mjs'
import { loadArtifacts } from '../../src/hooklab-owner-driver/artifacts.mjs'
import { PROGRAMS, QUOTE_MINT, MAINNET_GENESIS, LOADER, SYSTEM, derivedAddresses, holdingAddress, pda, kb } from '../../src/hooklab-owner-driver/pins.mjs'

export const sha = b => createHash('sha256').update(b).digest('hex')
const { coders } = loadArtifacts()
export const d = derivedAddresses(PROGRAMS, QUOTE_MINT)
export const owner = Keypair.fromSeed(createHash('sha256').update('WALLET FUNDING TEST FIXTURE ONLY').digest())
export const OWNER = owner.publicKey.toBase58(), COIN = '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn'
const elf = Buffer.alloc(64, 0x42)
export const pin = { ...BRIDGE_PIN, elfLength: elf.length, elfSha256: sha(elf) }
export const acct = (address, owner, data, lamports = '1000000', executable = false) => ({ address, owner, executable, lamports, dataBase64: Buffer.from(data).toString('base64') })
export const holdingBytes = (mint, who, amount, tamper = null) => {
  const b = Buffer.alloc(HOLDING_BYTES); createHash('sha256').update('account:Holding').digest().copy(b, 0, 0, 8); b[8] = 1
  b[9] = PublicKey.findProgramAddressSync([Buffer.from('holding'), kb(mint), kb(who)], new PublicKey(PROGRAMS.token))[1]
  kb(mint).copy(b, 10); kb(who).copy(b, 42); b.writeBigUInt64LE(BigInt(amount), 74); if (tamper) tamper(b); return b
}
export const quoteMintBytes = Buffer.from(readFileSync(new URL('./hooklab-quote-mint-mainnet.b64', import.meta.url), 'utf8'), 'base64')
export const mintWith = patch => { const v = { ...coders.token.accounts.decode('Mint', quoteMintBytes), ...patch }; const body = Buffer.concat([quoteMintBytes.subarray(0, 8), coders.token.types.encode('Mint', v)]); return Buffer.concat([body, Buffer.alloc(519 - body.length)]) }
export const coinBytes = mintWith({ decimals: 6, name: 'Hook Lab Canary', symbol: 'HLCANARY', mint_authority: null, hook_program: new PublicKey(PROGRAMS.gate), hook_flags: 1 })
const bridgeAccount = (name, value) => Buffer.concat([Buffer.from(loadArtifacts().idls.bridge.accounts.find(a => a.name === name).discriminator), coders.bridge.types.encode(name, value)])
export const config = patch => bridgeAccount('Config', { version: 1, bump: 250, admin: new PublicKey(pin.upgradeAuthority), paused: false, wrappers: new BN(2), reserved: Array(32).fill(0), ...patch })
export const wrapper = patch => bridgeAccount('Wrapper', { version: 1, bump: 255, wrapped_mint_bump: 254, native: true, underlying_mint: new PublicKey('So11111111111111111111111111111111111111112'),
  underlying_program: new PublicKey(SYSTEM), wrapped_mint: new PublicKey(QUOTE_MINT), vault: new PublicKey(d.bridgeSolVault), decimals: 9, total_wrapped: new BN(17000000000),
  registered_at: new BN(1760000000), registrar: new PublicKey(pin.upgradeAuthority), reserved: Array(32).fill(0), ...patch })
export const programDataBytes = (authority = pin.upgradeAuthority, code = elf) => { const b = Buffer.alloc(45 + code.length + 8); b.writeUInt32LE(3, 0); b[12] = 1; kb(authority).copy(b, 13); code.copy(b, 45); return b }
const programBytes = () => { const b = Buffer.alloc(36); b.writeUInt32LE(2, 0); kb(pin.programData).copy(b, 4); return b }

export function state({ walletLamports = '1000000000', quoteHolding = null, coinHolding = null, edit = {} } = {}) {
  return {
    [OWNER]: acct(OWNER, SYSTEM, Buffer.alloc(0), walletLamports),
    [holdingAddress(QUOTE_MINT, OWNER)]: quoteHolding === null ? null : acct(holdingAddress(QUOTE_MINT, OWNER), PROGRAMS.token, quoteHolding),
    [COIN]: acct(COIN, PROGRAMS.token, coinBytes), [holdingAddress(COIN, OWNER)]: coinHolding === null ? null : acct(holdingAddress(COIN, OWNER), PROGRAMS.token, coinHolding),
    [PROGRAMS.bridge]: acct(PROGRAMS.bridge, LOADER, programBytes(), '1141440', true), [pin.programData]: acct(pin.programData, LOADER, programDataBytes()),
    [d.bridgeConfig]: acct(d.bridgeConfig, PROGRAMS.bridge, config()), [d.bridgeNativeWrapper]: acct(d.bridgeNativeWrapper, PROGRAMS.bridge, wrapper()),
    [d.bridgeSolVault]: acct(d.bridgeSolVault, SYSTEM, Buffer.alloc(0), '17000900880'), [QUOTE_MINT]: acct(QUOTE_MINT, PROGRAMS.token, quoteMintBytes),
    [PROGRAMS.token]: acct(PROGRAMS.token, LOADER, programBytes(), '1141440', true), [pda(LOADER, kb(PROGRAMS.token))]: acct(pda(LOADER, kb(PROGRAMS.token)), LOADER, Buffer.alloc(8)),
    ...edit,
  }
}
export const NOW = 1_800_000_000_000

// Resolver: fake two-provider chain, a really signed transaction, and receipts with exact or wrong lamport movements.
export function chain({ rows, receipt = null, blockHeight = 1100, simulated = () => null }) {
  return {
    rpcEndpoint: '', getGenesisHash: async () => MAINNET_GENESIS,
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: 1000 }, value: keys.map(k => { const a = rows[k.toBase58()]; return a ? { owner: new PublicKey(a.owner), executable: a.executable, lamports: Number(a.lamports), data: Buffer.from(a.dataBase64, 'base64') } : null }) }),
    getMinimumBalanceForRentExemption: async bytes => bytes === HOLDING_BYTES ? 1686560 : 890880,
    getLatestBlockhashAndContext: async () => ({ context: { slot: 1000 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1150 } }),
    getBlock: async slot => slot === 1000 ? { blockhash: '11111111111111111111111111111111', blockHeight: 1000, parentSlot: 999 } : null,
    isBlockhashValid: async () => ({ context: { slot: 1000 }, value: true }), getBlockHeight: async () => 1000, getSlot: async () => 1000,
    getFeeForMessage: async () => ({ context: { slot: 1000 }, value: 7000 }),
    simulateTransaction: async (_tx, options) => ({ context: { slot: 1000 }, value: { err: null, accounts: options.accounts?.addresses.map(address => ({ lamports: simulated(address) })) ?? null } }),
    getTransaction: async () => receipt, getBlockSignatures: async () => ({ blockhash: '11111111111111111111111111111112', previousBlockhash: '11111111111111111111111111111113', blockHeight, signatures: receipt ? [receipt.signature] : [] }),
  }
}
export const bundle = JSON.parse(readFileSync(new URL('../../config/hooklab-production-bundle-2.json', import.meta.url), 'utf8'))
// Production limits carry the boot time (nowMs); a restart or deploy changes only that.
export const LIMITS = { maxAgeMs: 60000, maxSlotLag: 150, computeUnitPriceMicroLamports: '10000', maxNetworkFeeLamports: '29000' }
// from: the production bundle the server runs; reviewedProfiles: the reconcile allowlist (default: the code-pinned one).
export async function resolverFor(rows, receipts = [null, null], simulated = () => null, bootLimits = {}, { from = bundle, reviewedProfiles, clock = () => NOW } = {}) {
  const origins = from.config.providerTrustDomains.map(t => t.origin)
  const connections = from.profile.providers.map((provider, i) => ({ provider, connection: Object.assign(chain({ rows, receipt: receipts[i], simulated }), { rpcEndpoint: origins[i] + 'rpc' }) }))
  const limits = { ...LIMITS, ...bootLimits }
  const tokenData = Buffer.from(rows[pda(LOADER, kb(PROGRAMS.token))].dataBase64, 'base64')
  return { resolver: walletFundingResolver({ config: from.config, profile: from.profile, dossierJson: from.dossierJson, connections, limits, clock, bridgePin: pin,
    tokenProgramDataSha256: sha(tokenData), ...(reviewedProfiles ? { reviewedProfiles } : {}) }), connections }
}
// The next production bundle: today's, under a new reviewed profile (as bundle 3 will follow bundle 2).
export function nextBundle(base) {
  const json = JSON.stringify({ ...JSON.parse(base.profile.json), profileId: 'production-next-bundle' }), profile = { ...base.profile, json, expectedSha256: sha(json) }
  const dossier = JSON.parse(base.dossierJson); dossier.artifacts.profileSha256 = profile.expectedSha256
  const dossierJson = JSON.stringify(dossier)
  return { ...base, profile, dossierJson, config: { ...base.config, profileSha256: profile.expectedSha256, dossierSha256: sha(dossierJson) } }
}
export const receiptFor = (review, signed, movements, error = null) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(signed, 'base64')), keys = review.accounts.map(a => a.address)
  const pre = keys.map(() => 10_000_000_000), post = keys.map((k, i) => pre[i] + Number(movements[k] ?? 0))
  return { signature: bs58.encode(tx.signatures[0]), slot: 1001, transaction: { message: tx.message, signatures: tx.signatures.map(s => bs58.encode(s)) },
    meta: { err: error, fee: 7000, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] } } }
}
export const HOLDING_RENT = 1686560
export const exactFund = (lamports, creates) => address => address === OWNER ? 1_000_000_000 - 7000 - creates * HOLDING_RENT - lamports : HOLDING_RENT
