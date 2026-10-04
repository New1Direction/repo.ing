// Chain state for stock-pair reconciliation tests, encoded with the programs' own account coders (no validator): a DBC curve
// pool and its config, a DAMM v2 pool with its two locked positions, and the custody's Token-2022 account. fakeConnection
// serves exactly these accounts to the readers in src/stock-reconcile.mjs and to the SOL reconciler.
import BN from 'bn.js'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { ACCOUNT_SIZE, AccountLayout, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'

export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const METAX_MINT = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'
const offline = new Connection('http://127.0.0.1:1')
const dbcCoder = new DynamicBondingCurveClient(offline, 'finalized').state.getProgram().coder.accounts
const ammCoder = new CpAmm(offline)._program.coder.accounts

export const key = () => Keypair.generate().publicKey.toBase58()

// Every field zero, then the given ones: encoded with the account's own layout (anchor's encode() caps accounts at 1000 bytes).
function encode(coder, name, set) {
  const discriminator = Buffer.from(coder.accountDiscriminator(name)), size = coder.size(name)
  const state = coder.decode(name, Buffer.concat([discriminator, Buffer.alloc(size - discriminator.length)]))
  set(state)
  const body = Buffer.alloc(size)
  const length = coder.accountLayouts.get(name).layout.encode(state, body)
  return Buffer.concat([discriminator, body.subarray(0, length)])
}
const bn = value => new BN(String(value))

export const curvePool = ({ config, creator, baseMint, creatorQuoteFee = 0n, partnerQuoteFee = 0n, migrated = false, baseFee = 0n }) =>
  ({ owner: DBC_PROGRAM_ID, data: encode(dbcCoder, 'virtualPool', state => Object.assign(state.poolState, {
    config: new PublicKey(config), creator: new PublicKey(creator), baseMint: new PublicKey(baseMint),
    creatorQuoteFee: bn(creatorQuoteFee), partnerQuoteFee: bn(partnerQuoteFee), creatorBaseFee: bn(baseFee), isMigrated: migrated ? 1 : 0 })) })

export const curveConfig = ({ quoteMint, feeClaimer, creatorTradingFeePercentage = 71 }) =>
  ({ owner: DBC_PROGRAM_ID, data: encode(dbcCoder, 'poolConfig', state => Object.assign(state, {
    quoteMint: new PublicKey(quoteMint), feeClaimer: new PublicKey(feeClaimer), creatorTradingFeePercentage })) })

export const dammPool = ({ tokenAMint, tokenBMint, collectFeeMode = 1 }) =>
  ({ owner: CP_AMM_PROGRAM_ID, data: encode(ammCoder, 'pool', state => Object.assign(state, {
    tokenAMint: new PublicKey(tokenAMint), tokenBMint: new PublicKey(tokenBMint), collectFeeMode })) })

// Fees accrued and not yet claimed (feeBPending; fee growth is zero) and fees claimed so far, in the quote (token B).
export const dammPosition = ({ pool, unclaimed = 0n, claimed = 0n, unclaimedA = 0n }) =>
  ({ owner: CP_AMM_PROGRAM_ID, data: encode(ammCoder, 'position', state => {
    state.pool = new PublicKey(pool); state.feeBPending = bn(unclaimed); state.feeAPending = bn(unclaimedA)
    state.metrics.totalClaimedBFee = bn(claimed)
  }) })

export function token2022Account({ mint, owner, amount }) {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode({ mint: new PublicKey(mint), owner: new PublicKey(owner), amount: BigInt(amount), delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data)
  return { owner: TOKEN_2022_PROGRAM_ID, data }
}

// accounts: Map of address → { owner, data } (or a function returning it, read on every call). fail: a predicate that makes
// a read throw, as an RPC outage would.
export function fakeConnection(accounts, { slot = 1000, fail = () => false, rpcEndpoint = `fake://${key()}` } = {}) {
  const info = address => {
    if (fail(address)) throw Error('rpc unavailable')
    const value = accounts.get(address)
    const account = typeof value === 'function' ? value() : value
    return account ? { ...account, lamports: 1_000_000, executable: false, rentEpoch: 0 } : null
  }
  return { rpcEndpoint, commitment: 'finalized', reads: [],
    async getAccountInfo(address) { this.reads.push(new PublicKey(address).toBase58()); return info(new PublicKey(address).toBase58()) },
    async getAccountInfoAndContext(address) { return { context: { slot }, value: await this.getAccountInfo(address) } },
    async getMultipleAccountsInfoAndContext(keys) {
      const addresses = keys.map(k => new PublicKey(k).toBase58()); this.reads.push(...addresses)
      return { context: { slot }, value: addresses.map(info) }
    } }
}

// A stock market (METAx unless another registry asset is named) with its canonical pool derived from (the stock's mint, mint,
// config), as the quote-aware resolver requires.
const ASSET_MINTS = { 'meta-xstock': METAX_MINT, 'msft-xstock': 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', 'nvda-xstock': 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' }
export function stockMarket({ repoId = '94911145', assetId = 'meta-xstock', config = key(), mint = key(), creator = key(), launcher = key() } = {}) {
  const quoteMint = ASSET_MINTS[assetId]
  const pool = deriveDbcPoolAddress(new PublicKey(quoteMint), new PublicKey(mint), new PublicKey(config)).toBase58()
  return { githubRepoId: repoId, repoId, status: 'confirmed', mint, pool, creatorWallet: creator, launcherWallet: launcher, config,
    quoteAssetId: assetId, quoteMint, indexedAt: new Date('2026-10-01T00:00:00Z'), launchFinality: 'finalized' }
}
