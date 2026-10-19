// Owner-driver public pins. Addresses only: no keys, RPC access or signing here.
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { LEGACY_STACK } from '../hooklab-stack.mjs'

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
export const SYSTEM = '11111111111111111111111111111111'
export const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111'
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112'
export const LOCAL_PROFILE_SCHEMA = 'hook-lab/local-inclusive-max-wallet-builder-profile/1'

// The LEGACY stack (bundle 2 as deployed; src/hooklab-stack.mjs): the canary, the bridged flows and the stages that
// manage them. Our own stack's programs and marker come from its profile/bundle, never from here.
export const PROGRAMS = LEGACY_STACK.programs
export const QUOTE_MINT = LEGACY_STACK.quoteMint

// Owner custody role addresses (public keys only). Mainnet mode never accepts substitutes.
export const MAINNET_ROLES = Object.freeze({
  admin: 'DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5',
  guardian: 'CT4SioSvVFHcnuJbJMfcVgdR3GHAyK7VmrjvR6y3RmEY',
  treasury: 'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i',
  upgrade: '9GCfczwLVfyGTE4RRrEHbGqSdHGD35U3Z5ifo7YEN1md',
  payer: '3eCFwDiKetHe9pg1zNEkTohUECu2vtsZDRMZ3jeR4g5o',
  creator: 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9',
  mint: '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn',
})
export const ROLE_NAMES = Object.freeze(['admin', 'guardian', 'treasury', 'upgrade', 'payer', 'creator', 'mint', 'selectedConfig'])

// Independently recorded addresses; unit tests prove the derivations below reproduce them.
export const MAINNET_DERIVED = Object.freeze({
  launchConfig: 'DkzaEgALTrq6H9Gw2ugpFvbTfwfSx2AHnPBN2nQptocw',
  launchGovernance: '7UMHpxTLWPcoNMFffkzw7SH2d3qCR7TzAd1UdfkBxpKH',
  swapConfig: 'HgqTsdUHxpF2AZAwQck4CgTcYBc7mbzxaP17dACgxTLn',
  swapGovernance: 'GJtXZdkBJzEWG4876i8BFcaf6gXy3BEUntGyYUUfZ2ZD',
  gateProgramData: 'GC3cuBuTstMXscgSXSEnRWDerW8iie9w1np3Q9b6MKo8',
  bridgeConfig: 'Dwf4C8tTMYwicp8cU5MYcTtMQVVJTN7W3LcXCQ1UEhMs',
  bridgeSolVault: 'EAcZR2i8A6BbnKRdWuyMVDTuiNkD6qc4RkFpxUYJ9Qba',
  bridgeNativeWrapper: '3ta59VvLDKLnCKMhYihiC3fQ7W9jPKty6xfx3h5puHGS',
  creatorQuote: 'Ct5SCe1bMqpPm6DN4iuKVcP77gyv5vQyzEP6Zc7gbK85',
  treasuryQuote: 'GpFsm7FLfvkykG83VY55wwxxpWKoDeUcMeTB5ddHrhBx',
  creatorAuthorization: 'Ehfpy1rTpv9uiVpmWUKgYfM6ZQ9bYxuPFNCcxtpgu2mv',
})

export const pk = value => new PublicKey(value)
export const kb = value => pk(value).toBuffer()
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const seedBytes = seed => typeof seed === 'string' ? Buffer.from(seed) : Buffer.from(seed)
export const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(seedBytes), pk(program))[0].toBase58()
export const pdaBump = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(seedBytes), pk(program))[1]
const required = (value, name) => { if (!value) throw Error(`${name} is required (it comes from the stack's profile)`); return value }
export const holdingAddress = (mint, owner, token) => pda(required(token, 'The token program'), 'holding', kb(mint), kb(owner))

// The stack's derived addresses. The bridge's appear only for a stack that has one (the legacy stack).
export function derivedAddresses(programs, quoteMint) {
  const { launch: L, swap: S, gate: G, token: T, bridge: B } = required(programs, 'The stack\'s programs')
  return Object.freeze({
    launchConfig: pda(L, 'config'), launchGovernance: pda(L, 'governance'),
    swapConfig: pda(S, 'config'), swapGovernance: pda(S, 'governance'),
    launchProgramData: pda(LOADER, kb(L)), swapProgramData: pda(LOADER, kb(S)), gateProgramData: pda(LOADER, kb(G)),
    tokenProgramData: pda(LOADER, kb(T)),
    launchEventAuthority: pda(L, '__event_authority'), swapEventAuthority: pda(S, '__event_authority'),
    tokenEventAuthority: pda(T, '__event_authority'),
    ...(B ? { bridgeProgramData: pda(LOADER, kb(B)), bridgeEventAuthority: pda(B, '__event_authority'),
      bridgeConfig: pda(B, 'config'), bridgeSolVault: pda(B, 'sol-vault'), bridgeNativeWrapper: pda(B, 'wrapper', kb(NATIVE_MINT)) } : {}),
    quoteMint,
  })
}
export const authorizationAddress = (creator, launch) => pda(required(launch, 'The launch program'), 'creator-authorization', kb(creator))

export function canaryAddresses(programs, quoteMint, mint) {
  const { launch: L, swap: S, gate: G, token: T } = programs
  const zeroFee = Buffer.alloc(2)
  const launch = pda(L, 'launch', kb(mint)), pool = pda(S, 'pool', kb(mint), kb(quoteMint), zeroFee, kb(L))
  return Object.freeze({ launch, pool, lpMint: pda(S, 'lp', kb(pool)), policy: pda(G, 'policy-v2', kb(mint)),
    registry: pda(G, 'bordrless-hook-accounts', kb(mint)), inclusiveFeePolicy: pda(S, 'inclusive-fee-policy', kb(pool)),
    launchQuote: holdingAddress(quoteMint, launch, T), baseVault: holdingAddress(mint, pool, T), quoteVault: holdingAddress(quoteMint, pool, T) })
}
