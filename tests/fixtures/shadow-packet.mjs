import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import bs58 from 'bs58'
import BN from 'bn.js'
import { createRpcTape, digest } from '../../scripts/shadow/boundary.mjs'

export async function curvePacket(lane, at = '2026-10-25T02:30:00.000Z') {
  const fixture = JSON.parse(readFileSync(new URL('./recovered-curve-public-accounts.json', import.meta.url)))
  const { binding: b } = fixture
  const slot = fixture.slot
  const market = { repoId: b.repoId, pool: b.curve, mint: b.mint, creatorWallet: b.previousOwner,
    launchSignature: bs58.encode(Buffer.alloc(64, 9)), bundleId: null, earlyAccessEnd: null, transferHookProgram: null,
    discoveryVersion: 2, launchBlockTime: '2026-10-24T02:30:00.000Z' }
  const dbc = new DynamicBondingCurveClient({ rpcEndpoint: 'https://fixture.invalid' }, 'finalized')
  const coder = dbc.state.getProgram().coder, config = new PublicKey(b.config), pool = new PublicKey(b.curve), mint = new PublicKey(b.mint)
  const fixed = coder.accounts.decode('poolConfig', Buffer.from(fixture.accounts[1].data, 'base64'))
  fixed.creatorTradingFeePercentage = 71
  const layout = coder.accounts.accountLayouts.get('poolConfig'), encoded = Buffer.alloc(8192)
  const length = layout.layout.encode(fixed, encoded)
  fixture.accounts[1].data = Buffer.concat([Buffer.from(layout.discriminator), encoded.subarray(0, length)]).toString('base64')
  const account = i => ({ ...fixture.accounts[i], data: [fixture.accounts[i].data, 'base64'], executable: false, lamports: 10000000, rentEpoch: 0 })
  const signatures = [bs58.encode(Buffer.alloc(64, 10)), bs58.encode(Buffer.alloc(64, 11))]
  const transaction = (signature, fee, n) => {
    const data = { pool, config, tradeDirection: 1, hasReferral: false,
      params: { amountIn: new BN(100), minimumAmountOut: new BN(1) }, amountIn: new BN(100),
      currentTimestamp: new BN(Date.parse(at) / 1000), swapResult: { actualInputAmount: new BN(95), outputAmount: new BN(10),
        nextSqrtPrice: new BN(100), tradingFee: new BN(fee), protocolFee: new BN(1), referralFee: new BN(0) } }
    const event = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'),
      Buffer.from(dbc.state.getProgram().idl.events.find(e => e.name === 'evtSwap').discriminator), coder.types.encode('evtSwap', data)])
    const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
    return { slot: slot - 2 + n, blockTime: Date.parse(at) / 1000, version: 'legacy',
      transaction: { signatures: [signature], message: {
        accountKeys: [key(1), b.config, b.curve, key(2), key(3), key(4), key(5), mint.toBase58(), NATIVE_MINT.toBase58(), key(6), 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'],
        header: { numRequiredSignatures: 1 }, instructions: [{ programIdIndex: 10, accounts: [0,1,2,3,4,5,6,7,8,9], data: bs58.encode(Buffer.from([248,198,158,145,225,117,135,200])) }] } },
      meta: { err: null, fee: 5000, preBalances: [10000], postBalances: [5000], preTokenBalances: [], postTokenBalances: [],
        innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 10, accounts: [], stackHeight: 2, data: bs58.encode(event) }] }] } }
  }
  const packet = { version: 2, lane, at, completedAt: at,
    timings: [{ repoId: market.repoId, startedAt: at, acquiredAt: at, validatedAt: at }],
    config: b.config, legacyConfigs: '', custody: { version: 1, poolCreators: [b], positions: [] },
    db: { markets: [market], cursors: [{ pool: b.curve, last_signature: market.launchSignature, last_slot: String(slot - 3) }],
      ...(lane === 'chart' ? { graduates: [], chartCursors: [], trades: [], dammTrades: [] } : { fees: [], discovery: [], graduated: [], platform: [] }) } }
  const tape = createRpcTape({ endpoints: { primary: 'https://primary.invalid', verification: 'https://verification.invalid', archive: 'https://archive.invalid' },
    fetchImpl: async (_url, options) => {
      const { method, params } = JSON.parse(options.body)
      let result
      if (method === 'getGenesisHash') result = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
      else if (method === 'getBlockTime') result = Date.parse(at) / 1000
      else if (method === 'getMultipleAccounts') result = { context: { slot }, value: params[0].map(a => account(a === b.curve ? 0 : 1)) }
      else if (method === 'getAccountInfo') result = { context: { slot }, value: account(params[0] === b.curve ? 0 : 1) }
      else if (method === 'getSignaturesForAddress') result = [...signatures.map((signature, i) => ({ signature, slot: slot - 2 + i, err: null, memo: null, blockTime: Date.parse(at) / 1000, confirmationStatus: 'finalized' })).reverse(),
        { signature: market.launchSignature, slot: slot - 3, err: null, memo: null, blockTime: Date.parse(at) / 1000, confirmationStatus: 'finalized' }]
      else if (method === 'getTransaction') { const n = signatures.indexOf(params[0]); result = transaction(params[0], [2,4][n], n) }
      else throw Error('Unexpected fixture RPC')
      return new Response(JSON.stringify({ result }))
    } })
  return { packet, tape }
}

export async function graduatedPacket(lane) {
  const { packet } = await curvePacket(lane)
  const template = JSON.parse(readFileSync(new URL('./recovered-curve-public-accounts.json', import.meta.url)))
  const accounts = JSON.parse(readFileSync(new URL('./repoing-graduated-accounts.json', import.meta.url)))
  const swaps = JSON.parse(readFileSync(new URL('./repoing-damm-swaps.json', import.meta.url)))
  const key = value => new PublicKey(value)
  const market = { ...packet.db.markets[0], repoId: '1388219884', mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be',
    pool: 'Gda7Sig9EtVpB7EMVWG1eAAoX8kvq4j68nELsnq3Qfi7', creatorWallet: 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' }
  packet.config = '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M'
  packet.custody = { version: 1, poolCreators: [], positions: [] }
  packet.db.markets = [market]
  packet.timings[0].repoId = market.repoId
  const dbcProgram = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', ammProgram = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'
  const coder = new DynamicBondingCurveClient({ rpcEndpoint: 'https://fixture.invalid' }, 'finalized').state.getProgram().coder
  const virtual = coder.accounts.decode('virtualPool', Buffer.from(template.accounts[0].data, 'base64'))
  Object.assign(virtual.poolState, { config: key(packet.config), baseMint: key(market.mint), creator: key(market.creatorWallet), isMigrated: 1 })
  const fixed = coder.accounts.decode('poolConfig', Buffer.from(template.accounts[1].data, 'base64'))
  Object.assign(fixed, { migrationOption: 1, creatorPermanentLockedLiquidityPercentage: 50, partnerPermanentLockedLiquidityPercentage: 50,
    migrationFeeOption: 2, feeClaimer: key('H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3') })
  const encode = (name, value) => { const l = coder.accounts.accountLayouts.get(name), buf = Buffer.alloc(8192), n = l.layout.encode(value, buf)
    return Buffer.concat([Buffer.from(l.discriminator), buf.subarray(0, n)]).toString('base64') }
  const all = [...accounts.accounts, { address: market.pool, owner: dbcProgram, data: encode('virtualPool', virtual) },
    { address: packet.config, owner: dbcProgram, data: encode('poolConfig', fixed) }]
  const [target, position, nftAccount, partnerPosition, partnerNftAccount] = accounts.accounts.map(a => a.address)
  const signature = bs58.encode(Buffer.alloc(64, 12)), slot = 451432143, blockTime = 1789999999
  const addresses = { 0: market.pool, 2: packet.config, 4: target, 5: '7QdbWrPPAmsGrm2VVc9Eyt2gj4HDnjt7doxv3GUVBUx7',
    6: nftAccount, 7: position, 8: '63nLdMVdn7H4QHLQx6jP2mvKmSjANSnib1yx5iujtzYV', 9: partnerNftAccount,
    10: partnerPosition, 12: ammProgram, 13: market.mint, 14: NATIVE_MINT.toBase58() }
  const keys = [dbcProgram, ...Array.from({ length: 15 }, (_, i) => addresses[i] ?? new PublicKey(Buffer.alloc(32, i + 20)).toBase58())]
  const tx = { slot, blockTime, version: 'legacy', transaction: { signatures: [signature], message: { accountKeys: keys,
    instructions: [{ programIdIndex: 0, accounts: Array.from({ length: 15 }, (_, i) => i + 1), data: bs58.encode(Buffer.from([156,169,230,103,53,228,80,64])) }] } },
    meta: { err: null, innerInstructions: [], preBalances: keys.map(() => 1), postBalances: keys.map(() => 1), preTokenBalances: [], postTokenBalances: [], fee: 0 } }
  const migration = { signature, slot, blockTime, curve: market.pool, config: packet.config, mint: market.mint, pool: target,
    creatorPosition: position, partnerPosition, transactionHash: digest(tx.transaction),
    pre: { native: keys.map(address => ({ address, lamports: '1' })), tokens: [] },
    post: { native: keys.map(address => ({ address, lamports: '1' })), tokens: [] } }
  packet.db.cursors = [{ pool: market.pool, last_signature: market.launchSignature, last_slot: String(slot - 1) },
    { pool: target, last_signature: signature, last_slot: String(slot) }]
  if (lane === 'chart') packet.db.graduates = [{ github_repo_id: market.repoId, pool: target, signature, slot: String(slot), evidence: JSON.stringify({ migration }), evidence_hash: digest(migration) }]
  const receipts = [swaps.buy, swaps.sell], boundary = { signature: market.launchSignature, slot: slot - 1 }
  const tape = createRpcTape({ endpoints: { primary: 'https://primary.invalid', verification: 'https://verification.invalid', archive: 'https://archive.invalid' },
    fetchImpl: async (_url, options) => {
      const { method, params } = JSON.parse(options.body)
      const info = address => { const a = all.find(a => a.address === address); if (!a) throw Error('Unknown fixture account')
        return { owner: a.owner, data: [a.data, 'base64'], executable: false, lamports: 10000000, rentEpoch: 0 } }
      let result
      if (method === 'getGenesisHash') result = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
      else if (method === 'getBlockTime') result = Date.parse(packet.at) / 1000
      else if (method === 'getMultipleAccounts') result = { context: { slot: accounts.slot }, value: params[0].map(info) }
      else if (method === 'getAccountInfo') result = { context: { slot: accounts.slot }, value: info(params[0]) }
      else if (method === 'getSignaturesForAddress') result = (params[0] === target
        ? [...receipts.map(t => ({ signature: t.transaction.signatures[0], slot: t.slot })).reverse(), { signature, slot }]
        : [{ signature, slot }, boundary]).map(r => ({ ...r, err: null, memo: null, blockTime, confirmationStatus: 'finalized' }))
      else if (method === 'getTransaction') result = params[0] === signature ? tx : receipts.find(t => t.transaction.signatures[0] === params[0])
      else throw Error('Unexpected fixture RPC')
      return new Response(JSON.stringify({ result }))
    } })
  return { packet, tape }
}
