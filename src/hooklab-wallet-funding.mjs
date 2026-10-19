// Customer wallet funding for Hook Lab trades, compiled from two-provider finalized observations. Pure: no RPC,
// keys, signing or sending. A buy needs the trader's bridged-SOL holding (funded) and the coin's holding to exist;
// a sell pays out bridged SOL, which withdraw unwraps back to wallet SOL.
//   fund:     create any missing holding (bridged SOL, and the coin's when `mint` is given), then wrap `lamports`.
//   withdraw: unwrap `lamports` raw bridged SOL from the trader's holding back to the wallet (1 raw unit = 1 lamport).
// The bridge (CtLk...) is a third-party upgradeable program, so its exact code, upgrade authority, config, wrapper and
// mint are pinned and re-checked on every review; any change refuses.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ComputeBudgetProgram, PublicKey, TransactionMessage } from '@solana/web3.js'
import { z } from 'zod'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { loadArtifacts } from './hooklab-owner-driver/artifacts.mjs'
import { createHolding, unwrapSol, wrapSol } from './hooklab-owner-driver/instructions.mjs'
import { LOADER, NATIVE_MINT, SYSTEM, derivedAddresses, holdingAddress, pda, kb } from './hooklab-owner-driver/pins.mjs'

const check = (ok, message) => { if (!ok) throw Error(message) }
// A refusal the customer can act on: its message is shown as is (the lifecycle masks every other error).
export const USER_REFUSAL = 'HOOKLAB_USER_REFUSAL'
export const refuse = (ok, message) => { if (!ok) throw Object.assign(Error(message), { code: USER_REFUSAL }) }
const sha = value => createHash('sha256').update(value).digest('hex')
const key = z.string().max(44).refine(v => { try { return new PublicKey(v).toBase58() === v } catch { return false } })
const u64 = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(v => BigInt(v) <= 0xffffffffffffffffn)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

// Mainnet bridge pins, observed 2026-10-18 (slot ~458649000). The ELF is the deployed program-data payload.
export const BRIDGE_PIN = Object.freeze({
  program: 'CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7', programData: '2c3D4AfndnSGBxVtr94sXYcU5HyNBrwYoityAxzQg2yJ',
  upgradeAuthority: '5xsibKwtiN6ruxsYrEyWVpV3KcwuzSPbQd1n28a7spEd',
  elfLength: 291952, elfSha256: '9866c6b42409a9465756040f623c70200a10bd24bf3408f23abe1d2d98f25591',
})
export const HOLDING_BYTES = 204
// Compute budget for up to two holding creations and one wrap or unwrap.
export const FUNDING_COMPUTE_UNITS = 200000

export const walletFundingRequestSchema = z.object({
  schema: z.literal('repoing/hooklab-wallet-funding-request/1'),
  action: z.enum(['fund', 'withdraw']), owner: key, mint: key.nullable(), lamports: u64,
}).strict()

// Every account a funding review reads, in a fixed order.
export function walletFundingInventory(profile, requestInput, pin = BRIDGE_PIN) {
  const r = walletFundingRequestSchema.parse(requestInput), p = profile.programs, d = derivedAddresses(p, profile.quoteMint)
  return [...new Set([r.owner, holdingAddress(profile.quoteMint, r.owner, p.token), ...(r.mint ? [r.mint, holdingAddress(r.mint, r.owner, p.token)] : []),
    p.bridge, pin.programData, d.bridgeConfig, d.bridgeNativeWrapper, d.bridgeSolVault, profile.quoteMint, p.token, pda(LOADER, kb(p.token))])].sort()
}

function canonicalHolding(account, token, mint, owner) {
  if (account === null) return null
  const bytes = Buffer.from(account.dataBase64, 'base64'), disc = createHash('sha256').update('account:Holding').digest().subarray(0, 8)
  const bump = PublicKey.findProgramAddressSync([Buffer.from('holding'), kb(mint), kb(owner)], new PublicKey(token))[1]
  check(account.owner === token && !account.executable && bytes.length === HOLDING_BYTES && bytes.subarray(0, 8).equals(disc) && bytes[8] === 1 && bytes[9] === bump
    && bytes.subarray(10, 42).equals(kb(mint)) && bytes.subarray(42, 74).equals(kb(owner)) && bytes.subarray(82).every(v => v === 0), 'Holding is not a canonical, undelegated holding')
  return bytes.readBigUInt64LE(74)
}

function decodeMint(account, token, coders) {
  const bytes = Buffer.from(account.dataBase64, 'base64'), disc = Buffer.from(loadArtifacts().idls.token.accounts.find(a => a.name === 'Mint').discriminator)
  check(account.owner === token && !account.executable && bytes.subarray(0, 8).equals(disc), 'Not a Hook Lab mint')
  return coders.token.accounts.decode('Mint', bytes)
}

// The bridge must be exactly the reviewed program, wrapping native SOL into the profile's quote mint 1:1.
function verifyBridge(accounts, profile, { requireUnpaused, pin = BRIDGE_PIN }) {
  const { coders } = loadArtifacts(), d = derivedAddresses(profile.programs, profile.quoteMint)
  const program = accounts.get(pin.program), data = accounts.get(pin.programData)
  check(program && program.owner === LOADER && program.executable && data && data.owner === LOADER && !data.executable, 'Bridge program is not deployed as reviewed')
  const pb = Buffer.from(program.dataBase64, 'base64'), db = Buffer.from(data.dataBase64, 'base64')
  check(pb.length === 36 && pb.readUInt32LE(0) === 2 && pb.subarray(4).equals(kb(pin.programData)), 'Bridge program data link differs')
  check(db.length >= 45 + pin.elfLength && db.readUInt32LE(0) === 3 && db[12] === 1 && db.subarray(13, 45).equals(kb(pin.upgradeAuthority))
    && sha(db.subarray(45, 45 + pin.elfLength)) === pin.elfSha256 && db.subarray(45 + pin.elfLength).every(v => v === 0), 'Bridge code or upgrade authority differs from its pin')
  const config = accounts.get(d.bridgeConfig), wrapper = accounts.get(d.bridgeNativeWrapper), vault = accounts.get(d.bridgeSolVault)
  check(config?.owner === pin.program && wrapper?.owner === pin.program && vault, 'Bridge accounts missing')
  const c = coders.bridge.accounts.decode('Config', Buffer.from(config.dataBase64, 'base64'))
  const w = coders.bridge.accounts.decode('Wrapper', Buffer.from(wrapper.dataBase64, 'base64'))
  check(c.version === 1, 'Bridge config differs')
  refuse(!requireUnpaused || c.paused === false, 'Adding SOL to Hook Lab is paused by the bridge right now. Withdrawals still work.')
  check(w.version === 1 && w.native === true && w.underlying_mint.toBase58() === NATIVE_MINT && w.underlying_program.toBase58() === SYSTEM
    && w.wrapped_mint.toBase58() === profile.quoteMint && w.vault.toBase58() === d.bridgeSolVault && w.decimals === 9, 'Bridge SOL wrapper differs')
  const quote = decodeMint(accounts.get(profile.quoteMint), profile.programs.token, coders)
  check(quote.version === 1 && quote.decimals === 9 && quote.mint_authority?.toBase58() === d.bridgeNativeWrapper && !quote.freeze_authority
    && !quote.hook_program && quote.hook_flags === 0, 'Bridged SOL mint differs')
  return { vault, totalWrapped: BigInt(w.total_wrapped.toString()) }
}
export { verifyBridge as verifyBridgeAccounts }

/** Compile a fund or withdraw review. input: { profile: { genesisHash, programs, quoteMint, profileSha256, providers },
 * request, observations[2], rent: { holdingLamports, walletLamports, vaultLamports }, recentBlockhash, limits }.
 * bridgePin exists for synthetic tests only; production always uses BRIDGE_PIN. */
export function compileWalletFundingReview(input) {
  const { profile, observations: obs, rent, recentBlockhash: bh, limits: l, bridgePin = BRIDGE_PIN } = input
  const r = walletFundingRequestSchema.parse(input.request), fund = r.action === 'fund', p = profile.programs, T = p.token
  check(bridgePin.program === p.bridge, 'Bridge pin differs from the profile')
  const inventory = walletFundingInventory(profile, r, bridgePin)
  check(Array.isArray(obs) && obs.length === 2 && new Set(obs.map(o => o.provider)).size === 2 && obs.every(o => profile.providers.includes(o.provider)), 'Two independent observations required')
  check(Math.abs(obs[0].slot - obs[1].slot) <= l.maxSlotLag && isDeepStrictEqual(obs[0].accounts, obs[1].accounts), 'Funding state observations disagree')
  for (const o of obs) check(o.genesisHash === profile.genesisHash && l.nowMs >= o.observedAtMs && l.nowMs - o.observedAtMs <= l.maxAgeMs, 'Stale or wrong-chain funding observation')
  const accounts = new Map(obs[0].accounts.map(x => [x.address, x.account]))
  check(isDeepStrictEqual([...accounts.keys()].sort(), inventory), 'Incomplete, duplicate or extra funding inventory')
  check(fund ? r.mint !== profile.quoteMint : r.mint === null, 'Funding request shape differs')
  const wallet = accounts.get(r.owner)
  refuse(wallet && wallet.owner === SYSTEM && !wallet.executable && Buffer.from(wallet.dataBase64, 'base64').length === 0, 'Use a regular wallet (Phantom, Solflare or Backpack) to trade Hooks coins.')
  const tokenProgram = accounts.get(T)
  check(tokenProgram?.owner === LOADER && tokenProgram.executable, 'Token program missing')
  const { vault, totalWrapped } = verifyBridge(accounts, profile, { requireUnpaused: fund, pin: bridgePin })
  // Deposits only into a fully backed bridge: every wrapped lamport must be in the vault above its rent.
  if (fund) refuse(BigInt(vault.lamports) - BigInt(rent.vaultLamports) >= totalWrapped, 'Adding SOL to Hook Lab is unavailable right now. Withdrawals still work.')
  const quoteAddress = holdingAddress(profile.quoteMint, r.owner, T), quoteBalance = canonicalHolding(accounts.get(quoteAddress), T, profile.quoteMint, r.owner)
  const coinAddress = r.mint ? holdingAddress(r.mint, r.owner, T) : null
  if (r.mint) {
    const coin = decodeMint(accounts.get(r.mint), T, loadArtifacts().coders)
    check(coin.version === 1 && coin.hook_program?.toBase58() === p.gate && !coin.mint_authority && !coin.freeze_authority, 'Not a Hooks coin')
    canonicalHolding(accounts.get(coinAddress), T, r.mint, r.owner)
  }
  const lamports = BigInt(r.lamports), holdingRent = BigInt(rent.holdingLamports)
  const creates = [[quoteAddress, profile.quoteMint], ...(r.mint ? [[coinAddress, r.mint]] : [])].filter(([address]) => fund && accounts.get(address) === null)
  const rentDebit = holdingRent * BigInt(creates.length)
  if (fund) refuse(lamports > 0n || creates.length > 0, 'Nothing to add: your Hook Lab accounts exist and no SOL was requested.')
  else {
    refuse(quoteBalance !== null && lamports > 0n && lamports <= quoteBalance, 'You can withdraw at most your SOL in Hook Lab.')
    refuse(BigInt(vault.lamports) - BigInt(rent.vaultLamports) >= lamports, 'The bridge cannot pay this out right now. Try again shortly.')
  }
  const priority = (BigInt(FUNDING_COMPUTE_UNITS) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
  const networkFee = BigInt(bh.lamportsPerSignature) + priority
  check(BigInt(bh.networkFeeLamports) === networkFee && networkFee <= BigInt(l.maxNetworkFeeLamports), 'Network fee differs from its explicit basis')
  const debit = fund ? rentDebit + lamports : 0n, walletAfter = BigInt(wallet.lamports) - networkFee - debit + (fund ? 0n : lamports)
  // The wallet must stay rent-exempt after paying the fee, before any withdrawn SOL arrives.
  refuse(walletAfter >= BigInt(rent.walletLamports) && BigInt(wallet.lamports) - networkFee >= BigInt(rent.walletLamports),
    fund ? 'Not enough SOL: keep about 0.001 SOL in your wallet for fees and its own rent.' : 'Your wallet needs about 0.001 SOL for the network fee.')
  const slot = Math.max(...obs.map(o => o.slot))
  check(bh.genesisHash === profile.genesisHash && isDeepStrictEqual(bh.providers, profile.providers) && l.nowMs >= bh.observedAtMs
    && l.nowMs - bh.observedAtMs <= l.maxAgeMs && bh.currentBlockHeight <= bh.lastValidBlockHeight && bh.lastValidBlockHeight - bh.currentBlockHeight <= 150
    && bh.observedSlot >= slot && bh.observedSlot - slot <= l.maxSlotLag && bh.observedSlot <= l.validUntilSlot && l.validUntilSlot - slot <= 150
    && l.reviewExpiresAtMs > l.nowMs && l.reviewExpiresAtMs - l.nowMs <= l.maxAgeMs, 'Review blockhash or offchain lifetime differs')
  const action = fund ? (lamports > 0n ? [wrapSol(p, profile.quoteMint, { user: r.owner, lamports: r.lamports })] : [])
    : [unwrapSol(p, profile.quoteMint, { user: r.owner, amount: r.lamports })]
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: FUNDING_COMPUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(l.computeUnitPriceMicroLamports) }),
    ...creates.map(([, mint]) => createHolding(p, { payer: r.owner, mint, owner: r.owner })), ...action]
  const message = new TransactionMessage({ payerKey: new PublicKey(r.owner), recentBlockhash: bh.blockhash, instructions }).compileToV0Message()
  const keys = message.getAccountKeys(), bytes = message.serialize()
  const review = { schema: 'hooklab-message-review/1', operation: `hooklab-wallet-${r.action}`, genesisHash: profile.genesisHash, profileSha256: profile.profileSha256,
    policySha256: sha(JSON.stringify(obs)), intentSha256: sha(JSON.stringify(r)), payer: r.owner, wallet: r.owner,
    messageBase64: Buffer.from(bytes).toString('base64'), messageSha256: sha(bytes), requiredSigners: [r.owner],
    accounts: Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: [], observedSlot: bh.observedSlot, validUntilSlot: l.validUntilSlot, observedAtMs: l.nowMs, reviewExpiresAtMs: l.reviewExpiresAtMs,
    lastValidBlockHeight: bh.lastValidBlockHeight, baseFeeLamports: String(bh.lamportsPerSignature), maxFeeLamports: String(networkFee),
    instructionDebitLamports: String(debit), maxNativeDebitLamports: String(networkFee + debit) }
  const inspected = inspectHookLabMessage(review)
  const canonical = instructions.map(ix => ({ program: ix.programId.toBase58(), dataHex: ix.data.toString('hex'),
    accounts: ix.keys.map(m => review.accounts.find(a => a.address === m.pubkey.toBase58())) }))
  check(message.header.numRequiredSignatures === 1 && isDeepStrictEqual(inspected.instructions, canonical), 'Compiled funding envelope differs')
  const quote = { action: r.action, lamports: r.lamports, networkFeeLamports: String(networkFee), rentLamports: String(rentDebit), holdingRentLamports: String(holdingRent),
    createdHoldings: creates.map(([address]) => address), quoteHolding: quoteAddress, coinHolding: coinAddress,
    quoteBalanceBefore: String(quoteBalance ?? 0n), quoteBalanceAfter: String((quoteBalance ?? 0n) + (fund ? lamports : -lamports)),
    walletLamportsBefore: String(wallet.lamports), walletLamportsAfter: String(walletAfter), vaultLamportsBefore: String(vault.lamports) }
  return Object.freeze({ schema: 'repoing/hooklab-wallet-funding-review/1', request: r, review, quote, instructions: inspected.instructions })
}
