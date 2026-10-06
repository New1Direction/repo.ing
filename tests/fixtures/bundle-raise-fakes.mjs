// Fakes for the Bundle raise flow's tests (tests/bundle-raise.test.mjs): Bundle and Backer account bytes in the program's layout
// (programs/bundle-vault, read back by src/bundle-vault.mjs), an in-memory chain with the RPC calls the flow makes, and a
// PostgreSQL stand-in that answers the flow's own queries. No validator, no database.
import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import { Keypair, PublicKey } from '@solana/web3.js'
import { BUNDLE_VAULT_PROGRAM_ID, STATUS } from '../../src/bundle-vault.mjs'

const discriminator = name => createHash('sha256').update(name).digest().subarray(0, 8)
const u8 = value => Buffer.from([value])
const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b }
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b }
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b }
const i64 = value => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b }
const u128 = value => Buffer.concat([u64(BigInt(value) & 0xffffffffffffffffn), u64(BigInt(value) >> 64n)])
const key = value => new PublicKey(value ?? PublicKey.default).toBuffer()
const POLICY = { maxTradeBps: 200, maxDailyBuyBps: 1_000, maxDailySellBps: 100, floorBps: 10_000, gapSecs: 600 }

// A Bundle account's data, field by field in decodeBundle's order; anything not given is zero.
export function bundleData(fields) {
  const f = { status: STATUS.RAISING, backerBps: 8_000, opsBps: 500, launchCooldownSecs: 180, launchGraceSecs: 86_400, policy: POLICY, ...fields }
  const p = f.policy
  return Buffer.concat([discriminator('account:Bundle'), u64(f.id), u64(f.repoId ?? 0), key(f.creator), u8(f.status), u8(f.graduated ? 1 : 0), u8(f.paused ? 1 : 0),
    u8(f.bump ?? 255), u8(f.vaultBump ?? 254), u64(f.target ?? 0), u64(f.minDeposit ?? 0), i64(f.deadline ?? 0), key(f.curveConfig), key(f.dammConfig),
    u16(f.backerBps), u16(f.opsBps), u32(f.launchCooldownSecs), u32(f.launchGraceSecs), u64(f.raised ?? 0), u64(f.refunded ?? 0), u64(f.released ?? 0),
    u64(f.opsPaid ?? 0), key(f.mint), key(f.pool), key(f.dammPool), key(f.routerPosition), key(f.routerPositionNft), key(f.vaultTokens), key(f.vaultSol),
    key(f.pot), i64(f.launchedAt ?? 0), i64(f.tradingOpensAt ?? 0), u16(p.maxTradeBps), u16(p.maxDailyBuyBps), u16(p.maxDailySellBps), u16(p.floorBps),
    u32(p.gapSecs), u64(f.costLamports ?? 0), u64(f.costTokens ?? 0), i64(f.day ?? 0), u64(f.dayBought ?? 0), u64(f.daySold ?? 0), i64(f.lastBuyAt ?? 0),
    i64(f.lastSellAt ?? 0), u64(f.vaultVolume ?? 0), u64(f.vaultFeeGenerated ?? 0), u64(f.vaultFeeOwed ?? 0), u64(f.vaultRebated ?? 0),
    u64(f.backerIncome ?? 0), u64(f.backerPaid ?? 0), u64(f.treasuryIncome ?? 0), u128(f.accPerShare ?? 0), Buffer.alloc(64)])
}

export const backerData = ({ bundle, wallet, shares, paid = 0n, bump = 253 }) =>
  Buffer.concat([discriminator('account:Backer'), key(bundle), key(wallet), u64(shares), u64(paid), u8(bump)])

// The RPC calls the raise flow makes, over an in-memory account map ({ owner, data }). onSend(raw): what landing does to the
// accounts. simulation: the next simulateTransaction's answer.
export function fakeChain() {
  const accounts = new Map(), sent = [], programReads = []
  const chain = {
    rpcEndpoint: 'http://127.0.0.1:1', accounts, sent, programReads, onSend: null,
    simulation: { err: null, logs: [], unitsConsumed: 40_000 }, signatureStatus: { confirmationStatus: 'confirmed', err: null },
    set(address, owner, data) { accounts.set(new PublicKey(address).toBase58(), { owner: new PublicKey(owner), data: Buffer.from(data), lamports: 1, executable: false }) },
    setProgramAccount(address, data) { chain.set(address, BUNDLE_VAULT_PROGRAM_ID, data) },
    async getAccountInfo(address) { return accounts.get(new PublicKey(address).toBase58()) ?? null },
    async getMultipleAccountsInfo(addresses) { return addresses.map(address => accounts.get(new PublicKey(address).toBase58()) ?? null) },
    async getProgramAccounts(programId, { filters = [], dataSlice } = {}) {
      programReads.push({ programId: new PublicKey(programId).toBase58(), filters, dataSlice })
      return [...accounts].filter(([, account]) => account.owner.equals(new PublicKey(programId)) && filters.every(({ memcmp }) =>
        account.data.subarray(memcmp.offset, memcmp.offset + bs58.decode(memcmp.bytes).length).equals(Buffer.from(bs58.decode(memcmp.bytes)))))
        .map(([address, account]) => ({ pubkey: new PublicKey(address), account: dataSlice ? { ...account, data: Buffer.alloc(0) } : account }))
    },
    async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 } },
    async simulateTransaction() { return { value: chain.simulation } },
    async getRecentPrioritizationFees() { return [] },
    async sendRawTransaction(raw) { sent.push(Buffer.from(raw)); chain.onSend?.(Buffer.from(raw)); return 'sent' },
    async getSignatureStatuses(signatures) { return { value: signatures.map(() => chain.signatureStatus) } },
    async getBlockHeight() { return 10 },
    async getTokenAccountBalance(address) {
      const account = accounts.get(new PublicKey(address).toBase58())
      if (!account) throw Error('could not find account')
      return { value: { amount: account.data.readBigUInt64LE(64).toString() } }
    },
  }
  return chain
}

// The raise flow's queries against a bundles table and a markets table held in memory. Every query is recorded.
export function fakePool({ bundles = new Map(), hasMarket = false } = {}) {
  const queries = []
  let nextId = 7n
  return {
    queries, bundles, setHasMarket(value) { hasMarket = value },
    async query(sql, params = []) {
      queries.push({ sql, params })
      if (/nextval\('bundle_id_seq'\)/.test(sql)) return { rows: [{ id: String(nextId++) }] }
      if (/select exists\(select 1 from bundles\)/.test(sql)) return { rows: [{ any: bundles.size > 0 }] }
      if (/exists\(select 1 from markets/.test(sql)) {
        const live = [...bundles.values()].find(row => row.githubRepoId === params[0] && params[1].includes(row.status))
        return { rows: [{ hasMarket, liveBundle: live?.status ?? null, liveBundleId: live?.bundleId ?? null }] }
      }
      if (/insert into bundles/.test(sql)) {
        const [bundleId, githubRepoId, address, creatorWallet, tokenName, tokenSymbol, tokenImage, targetLamports, minDepositLamports, deadline] = params
        bundles.set(bundleId, { bundleId, githubRepoId, address, creatorWallet, tokenName, tokenSymbol, tokenImage, targetLamports, minDepositLamports,
          deadline: new Date(deadline * 1000), status: 'opening', createSignature: null, createdAt: new Date(), ageMs: '0', fullName: 'octo/widget', owner: 'octo',
          name: 'widget', avatarUrl: null, description: 'A widget', marketMint: null })
        return { rows: [], rowCount: 1 }
      }
      if (/from bundles b join repositories r/.test(sql) && /b\.bundle_id = \$1/.test(sql)) {
        const row = bundles.get(params[0])
        return { rows: row ? [{ ...row }] : [] }
      }
      if (/from bundles b join repositories r/.test(sql)) return { rows: params[0].map(id => bundles.get(id)).filter(Boolean) }
      if (/update bundles set status = 'raising'/.test(sql)) {
        const row = bundles.get(params[0])
        if (!row || row.status !== 'opening') return { rows: [], rowCount: 0 }
        bundles.set(params[0], { ...row, status: 'raising', createSignature: params[1] ?? row.createSignature })
        return { rows: [], rowCount: 1 }
      }
      throw Error(`unexpected query: ${sql.slice(0, 60)}`)
    },
  }
}
