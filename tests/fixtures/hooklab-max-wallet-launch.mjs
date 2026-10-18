// Executed SBF vector adapted into strictly synthetic state, never a production receipt.
import { BorshCoder } from '@anchor-lang/core'
import { maxWalletRustVector, maxWalletProfileEnvelope, maxWalletPreparationRequest, maxWalletSnapshot, sha, pk, pda } from './hooklab-max-wallet-preparation.mjs'
export { maxWalletRustVector } from './hooklab-max-wallet-preparation.mjs'
export function maxWalletLaunchFixture() {
  const vector = maxWalletRustVector(), envelope = maxWalletProfileEnvelope(), profile = JSON.parse(envelope.json)
  const launch = new BorshCoder(JSON.parse(Buffer.from(envelope.idls.launch, 'base64'))), prep = maxWalletPreparationRequest()
  const decoded = launch.instruction.decode(Buffer.from(vector.launch.instruction.dataHex, 'hex')).data
  const { launch: L, swap: S, gate: G } = profile.programs, accounts = maxWalletSnapshot('launch'), accountMap = new Map(accounts.map(a => [a.address, a.account]))
  const config = launch.accounts.decode('Config', Buffer.from(accountMap.get(pda(L, 'config')).dataBase64, 'base64'))
  const request = { ...prep, schema: 'repoing/max-wallet-launch-request/1', reviewer: config.admin.toBase58(), name: decoded.args.name, symbol: decoded.args.symbol,
    uri: decoded.args.uri, virtualQuote: decoded.args.virtual_quote.toString(10) }
  const hashAccount = address => sha(Buffer.from(accountMap.get(address).dataBase64, 'base64'))
  const preparedAccountHashes = { policy: hashAccount(pda(G, 'policy', pk(prep.mint).toBuffer())), registry: hashAccount(pda(G, 'bordrless-hook-accounts', pk(prep.mint).toBuffer())), selectedConfig: hashAccount(prep.selectedConfig) }
  const state = { launchConfig: pda(L, 'config'), swapConfig: pda(S, 'config'), launchGovernance: pda(L, 'governance'), swapGovernance: pda(S, 'governance'), authorization: pda(L, 'creator-authorization', pk(prep.creator).toBuffer()), quoteMint: profile.quoteMint }
  const slot = Number(vector.slot), providers = envelope.providers
  // Manufactured solely for offline unsigned compilation/replay; never an observed live ALT.
  const addresses = [...new Set(vector.launch.instruction.keys.filter(k => !k.isSigner).map(k => k.pubkey))]
  const table = Buffer.alloc(56 + 32 * addresses.length)
  table.writeUInt32LE(1); table.writeBigUInt64LE(0xffffffffffffffffn, 4); table.writeBigUInt64LE(BigInt(slot - 1), 12)
  addresses.forEach((a, i) => pk(a).toBuffer().copy(table, 56 + i * 32))
  // The vector's union inventory also contains the selected-config ProgramData needed only in stage1.
  const inventory = new Set([...vector.launch.instruction.keys.map(k => k.pubkey), L, pda('BPFLoaderUpgradeab1e11111111111111111111111', pk(L).toBuffer()),
    pda('BPFLoaderUpgradeab1e11111111111111111111111', pk(S).toBuffer()), pda(S, 'governance'), request.feePayer])
  const launchAccounts = accounts.filter(a => inventory.has(a.address))
  return { profile: envelope, request,
    preparationEvidence: { schema: 'hooklab/max-wallet-synthetic-prepared-state/1', provenance: vector.provenance, status: 'synthetic-prepared',
      productionPreparationReceipt: null, profileSha256: envelope.expectedSha256, preparationIntentSha256: sha(JSON.stringify(prep)), executionSlot: slot, preparedAccountHashes },
    reviewedStateHashes: Object.fromEntries(Object.entries(state).map(([name, address]) => [name, hashAccount(address)])),
    observations: providers.map(provider => ({ provider, genesisHash: profile.genesisHash, commitment: 'finalized', slot, observedAtMs: 1000, accounts: structuredClone(launchAccounts) })),
    recentBlockhash: { blockhash: vector.blockhash, genesisHash: profile.genesisHash, providers, observedAtMs: 1000, currentBlockHeight: slot, blockhashValid: true,
      lastValidBlockHeight: slot + 150, observedSlot: slot, networkFeeLamports: '15000', lamportsPerSignature: '5000' },
    lookupTable: { address: pk(Buffer.alloc(32, 211)).toBase58(), owner: 'AddressLookupTab1e1111111111111111111111111', dataBase64: table.toString('base64'), sha256: sha(table) },
    limits: { nowMs: 1000, maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: Number(decoded.guard.deadline_slot.toString(10)), reviewExpiresAtMs: 6000,
      maxLaunchFeeLamports: decoded.guard.max_launch_fee_lamports.toString(10), maxPoolCreationFeeLamports: decoded.guard.max_pool_creation_fee_lamports.toString(10),
      maxRentLamports: decoded.guard.max_rent_lamports.toString(10), maxInstructionDebitLamports: decoded.guard.max_total_debit_lamports.toString(10),
      maxNetworkFeeLamports: '15000', maxTotalDebitLamports: String(BigInt(decoded.guard.max_total_debit_lamports.toString(10)) + 15000n),
      computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0' } }
}
