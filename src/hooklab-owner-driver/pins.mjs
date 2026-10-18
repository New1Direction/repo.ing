// Owner-driver public pins. Addresses only: no keys, RPC access or signing here.
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
export const SYSTEM = '11111111111111111111111111111111'
export const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111'
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112'
export const LOCAL_PROFILE_SCHEMA = 'hook-lab/local-inclusive-max-wallet-builder-profile/1'

export const PROGRAMS = Object.freeze({
  launch: 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft',
  swap: 'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk',
  gate: 'BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb',
  token: '2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22',
  bridge: 'CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7',
})
export const QUOTE_MINT = 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i'

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
export const holdingAddress = (mint, owner, token = PROGRAMS.token) => pda(token, 'holding', kb(mint), kb(owner))

export function derivedAddresses(programs = PROGRAMS, quoteMint = QUOTE_MINT) {
  const { launch: L, swap: S, gate: G, token: T, bridge: B } = programs
  return Object.freeze({
    launchConfig: pda(L, 'config'), launchGovernance: pda(L, 'governance'),
    swapConfig: pda(S, 'config'), swapGovernance: pda(S, 'governance'),
    launchProgramData: pda(LOADER, kb(L)), swapProgramData: pda(LOADER, kb(S)), gateProgramData: pda(LOADER, kb(G)),
    tokenProgramData: pda(LOADER, kb(T)), bridgeProgramData: pda(LOADER, kb(B)),
    launchEventAuthority: pda(L, '__event_authority'), swapEventAuthority: pda(S, '__event_authority'),
    tokenEventAuthority: pda(T, '__event_authority'), bridgeEventAuthority: pda(B, '__event_authority'),
    bridgeConfig: pda(B, 'config'), bridgeSolVault: pda(B, 'sol-vault'), bridgeNativeWrapper: pda(B, 'wrapper', kb(NATIVE_MINT)),
    quoteMint,
  })
}
export const authorizationAddress = (creator, launch = PROGRAMS.launch) => pda(launch, 'creator-authorization', kb(creator))

export function canaryAddresses(programs, quoteMint, mint) {
  const { launch: L, swap: S, gate: G, token: T } = programs
  const zeroFee = Buffer.alloc(2)
  const launch = pda(L, 'launch', kb(mint)), pool = pda(S, 'pool', kb(mint), kb(quoteMint), zeroFee, kb(L))
  return Object.freeze({ launch, pool, lpMint: pda(S, 'lp', kb(pool)), policy: pda(G, 'policy-v2', kb(mint)),
    registry: pda(G, 'bordrless-hook-accounts', kb(mint)), inclusiveFeePolicy: pda(S, 'inclusive-fee-policy', kb(pool)),
    launchQuote: holdingAddress(quoteMint, launch, T), baseVault: holdingAddress(mint, pool, T), quoteVault: holdingAddress(quoteMint, pool, T) })
}
