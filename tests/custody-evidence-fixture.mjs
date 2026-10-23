// Synthetic raw accounts only. NOT finalized chain evidence or custody-control proof.
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { CUSTODY_MEMBERS, CUSTODY_MULTISIG, MULTISIG_VAULT, SQUADS_PROGRAM } from '../src/custody-multisig.mjs'
import { Connection, Transaction, TransactionInstruction } from '@solana/web3.js'
import { DynamicBondingCurveClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID as DBC, deriveDbcPoolAuthority, deriveDbcEventAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createTransferCheckedInstruction } from '@solana/spl-token'
import BN from 'bn.js'
import bs58 from 'bs58'
import { prepareCustodyMultisig } from '../src/custody-multisig.mjs'
import { prepareCustodyPayout } from '../src/custody-settlement.mjs'
const pk = x => new PublicKey(x).toBuffer()
const n = (v, size) => { const b = Buffer.alloc(size); size === 8 ? b.writeBigUInt64LE(BigInt(v)) : b.writeUIntLE(v, 0, size); return b }
const tag = name => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8)
const pda = seeds => PublicKey.findProgramAddressSync(seeds, new PublicKey(SQUADS_PROGRAM))
export function governanceFixture(plan, slot = 50) {
  const [, bump] = pda([Buffer.from('multisig'), Buffer.from('multisig'), pk(CUSTODY_MEMBERS[0])])
  const [, vaultBump] = pda([Buffer.from('multisig'), pk(CUSTODY_MULTISIG), Buffer.from('vault'), n(0, 1)])
  const account = (address, name, bytes) => ({ address, owner: SQUADS_PROGRAM, executable: false, data: Buffer.concat([tag(name), ...bytes]) })
  return { slot, commitment: 'finalized', spendingLimitsComplete: true, spendingLimits: [],
    multisig: account(CUSTODY_MULTISIG, 'Multisig', [pk(CUSTODY_MEMBERS[0]), Buffer.alloc(32), n(2, 2), n(0, 4),
      n(plan.transactionIndex, 8), n(0, 8), n(1, 1), pk(MULTISIG_VAULT), n(bump, 1), n(3, 4),
      ...CUSTODY_MEMBERS.flatMap(k => [pk(k), n(7, 1)])]),
    transaction: account(plan.transaction, 'VaultTransaction', [pk(CUSTODY_MULTISIG), pk(plan.creator), n(plan.transactionIndex, 8),
      n(plan.transactionBump, 1), n(0, 1), n(vaultBump, 1), n(0, 4), plan.storedMessageBytes]),
    proposal: account(plan.proposal, 'Proposal', [pk(CUSTODY_MULTISIG), n(plan.transactionIndex, 8), n(5, 1), n(1, 8),
      n(plan.proposalBump, 1), n(2, 4), ...CUSTODY_MEMBERS.slice(0, 2).map(pk), n(0, 4), n(0, 4)]) }
}

// Offline asymmetric DBC evidence. No keys or signatures are generated and no RPC is called.
export async function dbcBatchFixture(role = 'creator', { tokenType = 0, amounts = [101n, 307n] } = {}) {
  const key = n => new PublicKey(Buffer.alloc(32, n)), owner = new PublicKey(MULTISIG_VAULT)
  const payer = key(240), authority = role === 'creator' ? owner : key(241)
  const baseProgram = tokenType === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
  const program = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:8899'), 'finalized').state.getProgram()
  const zero = type => {
    if (typeof type === 'string') return type === 'pubkey' ? PublicKey.default : /^u(64|128)$/.test(type) ? new BN(0) : 0
    if (type.array) return Array.from({ length: type.array[1] }, () => zero(type.array[0]))
    const def = program.idl.types.find(t => t.name === type.defined.name)
    return Object.fromEntries(def.type.fields.map(f => [f.name, zero(f.type)]))
  }
  const destination = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true)
  const claims = [], instructions = [], children = [], balances = []
  for (const [i, amount] of amounts.entries()) {
    const pool = key(10 + i), config = key(20 + i), mint = key(30 + i), baseVault = key(40 + i), quoteVault = key(50 + i)
    const baseAccount = getAssociatedTokenAddressSync(mint, owner, true, baseProgram)
    const a = { repoId: String(101 + i), role, phase: 'DBC', curve: pool.toBase58(), config: config.toBase58(), mint: mint.toBase58(), previousOwner: key(242).toBase58() }
    const poolState = { ...zero({ defined: { name: 'poolState' } }), config, creator: owner, baseMint: mint, baseVault, quoteVault, poolType: tokenType }
    const configState = { ...zero({ defined: { name: 'poolConfig' } }), quoteMint: NATIVE_MINT, feeClaimer: key(241), tokenType }
    const account = async (address, name, state) => {
      // Anchor's convenience encoder allocates only 1024 bytes; PoolConfig is 1048.
      const bytes = Buffer.alloc(4096), { layout } = program.coder.accounts.accountLayouts.get(name)
      const length = layout.encode(state, bytes)
      return { address: address.toBase58(), owner: DBC.toBase58(), executable: false,
        data: Buffer.concat([Buffer.from(program.idl.accounts.find(a => a.name === name).discriminator), bytes.subarray(0, length)]) }
    }
    claims.push({ attribution: a, maxQuoteAmount: amount, poolAccount: await account(pool, 'virtualPool', { poolState }),
      configAccount: await account(config, 'poolConfig', configState) })
    const common = { poolAuthority: deriveDbcPoolAuthority(), pool, tokenAAccount: baseAccount, tokenBAccount: destination,
      baseVault, quoteVault, baseMint: mint, quoteMint: NATIVE_MINT, tokenBaseProgram: baseProgram,
      tokenQuoteProgram: TOKEN_PROGRAM_ID, eventAuthority: deriveDbcEventAuthority(), program: DBC }
    const method = role === 'creator' ? program.methods.claimCreatorTradingFee(new BN(0), new BN(String(amount)))
      : program.methods.claimTradingFee(new BN(0), new BN(String(amount)))
    instructions.push(await method.accountsStrict(role === 'creator' ? { ...common, creator: authority } : { ...common, config, feeClaimer: authority }).instruction())
    const event = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), Buffer.from(role === 'creator'
      ? [154,228,215,202,133,155,214,138] : [26,83,117,240,92,202,112,254]), pool.toBuffer(), Buffer.alloc(16)])
    event.writeBigUInt64LE(amount, 56)
    children.push([createTransferCheckedInstruction(quoteVault, NATIVE_MINT, destination, deriveDbcPoolAuthority(), amount, 9),
      new TransactionInstruction({ programId: DBC, keys: [{ pubkey: deriveDbcEventAuthority(), isSigner: true, isWritable: false }], data: event })])
    balances.push([baseAccount, mint, owner, 0n, 0n], [quoteVault, NATIVE_MINT, deriveDbcPoolAuthority(), 1000n, 1000n - amount])
  }
  balances.push([destination, NATIVE_MINT, owner, 17n, 17n + amounts.reduce((sum, n) => sum + n, 0n)])
  const plan = { role, payer: payer.toBase58(), authority: authority.toBase58(), instructions, claims,
    observation: { slot: 50, commitment: 'finalized' }, ...(role === 'partner' ? { partnerReview: {
      id: 'explicit-exposed-authority-review', authority: authority.toBase58(), exposedAuthorityAcknowledged: true,
    } } : {}) }
  const multisigPlan = role === 'creator' ? prepareCustodyMultisig({ instructions, transactionIndex: 1n,
    creator: CUSTODY_MEMBERS[0], rentPayer: payer, approvers: CUSTODY_MEMBERS.slice(0, 2), executor: CUSTODY_MEMBERS[1] }) : null
  const top = multisigPlan ? [multisigPlan.executeInstruction] : instructions
  const inner = multisigPlan ? [{ index: 0, instructions: instructions.flatMap((instruction, i) => [
    { instruction, stackHeight: 2 }, ...children[i].map(instruction => ({ instruction, stackHeight: 3 }))]) }]
    : children.map((c, index) => ({ index, instructions: c.map(instruction => ({ instruction, stackHeight: 2 })) }))
  const message = new Transaction({ feePayer: payer, recentBlockhash: key(250).toBase58() }).add(...top).compileMessage()
  const keys = message.accountKeys
  const compiled = ({ instruction: ix, stackHeight }) => ({ programIdIndex: keys.findIndex(k => k.equals(ix.programId)),
    accounts: ix.keys.map(a => keys.findIndex(k => k.equals(a.pubkey))), data: bs58.encode(ix.data), stackHeight })
  const balance = (row, post) => ({ accountIndex: keys.findIndex(k => k.equals(row[0])), mint: row[1].toBase58(), owner: row[2].toBase58(),
    programId: (row[1].equals(NATIVE_MINT) ? TOKEN_PROGRAM_ID : baseProgram).toBase58(), uiTokenAmount: { amount: String(row[post ? 4 : 3]), decimals: row[1].equals(NATIVE_MINT) ? 9 : 6 } })
  const lamports = keys.map((k, i) => {
    const token = balances.find(r => r[0].equals(k) && r[1].equals(NATIVE_MINT))
    return 1000000 + (i === 0 ? -10000 : token ? Number(token[4] - token[3]) : 0)
  })
  return { plan, multisigPlan, governanceProof: multisigPlan ? governanceFixture(multisigPlan) : null,
    review: { top, inner }, finality: { signature: `synthetic-dbc-${role}`, slot: 50, confirmationStatus: 'finalized', err: null },
    tx: { slot: 50, transaction: { signatures: [`synthetic-dbc-${role}`, 'synthetic-second'], message }, meta: { err: null, fee: 10000,
      preBalances: keys.map(() => 1000000), postBalances: lamports,
      innerInstructions: inner.map(g => ({ index: g.index, instructions: g.instructions.map(compiled) })),
      preTokenBalances: balances.map(r => balance(r, false)), postTokenBalances: balances.map(r => balance(r, true)) } } }
}

// Separate governance-approved payout evidence. Collection itself is never payment.
export function dbcPayoutFixture(collection, { itemIndex = 0, amount = 31n, signature = 'synthetic-dbc-payout' } = {}) {
  const key = n => new PublicKey(Buffer.alloc(32, n)), payer = key(240), beneficiary = key(210)
  const attribution = collection.plan.claims[itemIndex].attribution
  const plan = prepareCustodyPayout({ amount, collectionSignature: collection.finality.signature,
    collectionItemIndex: itemIndex, attribution, payer, beneficiary, createAta: false,
    ...(attribution.role === 'creator' ? { beneficiaryBoundAt: '2026-10-01T00:00:00.000Z' } : {
      partnerRecipientPolicy: { id: 'reviewed-partner-recipient', repoId: attribution.repoId, recipient: beneficiary.toBase58() },
    }) })
  const multisigPlan = prepareCustodyMultisig({ instructions: plan.instructions, transactionIndex: 2n,
    creator: CUSTODY_MEMBERS[0], rentPayer: payer, approvers: CUSTODY_MEMBERS.slice(0, 2), executor: CUSTODY_MEMBERS[1] })
  const top = [multisigPlan.executeInstruction]
  const message = new Transaction({ feePayer: payer, recentBlockhash: key(250).toBase58() }).add(...top).compileMessage()
  const keys = message.accountKeys
  const balances = (post) => [[plan.source, MULTISIG_VAULT, post ? 1000n - amount : 1000n],
    [plan.destination, beneficiary.toBase58(), post ? 17n + amount : 17n]].map(([account, owner, n]) => ({
    accountIndex: keys.findIndex(k => k.toBase58() === account), mint: NATIVE_MINT.toBase58(), owner,
    programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: String(n), decimals: 9 },
  }))
  const inner = [{ index: 0, instructions: plan.instructions.map(instruction => ({ instruction, stackHeight: 2 })) }]
  return { plan, multisigPlan, governanceProof: governanceFixture(multisigPlan, 51), review: { top, inner },
    finality: { signature, slot: 51, confirmationStatus: 'finalized', err: null },
    tx: { slot: 51, transaction: { signatures: [signature, 'synthetic-second'], message }, meta: { err: null, fee: 10000,
      preBalances: keys.map(() => 1000000), postBalances: keys.map((k, i) => 1000000 + (i === 0 ? -10000 :
        k.toBase58() === plan.source ? -Number(amount) : k.toBase58() === plan.destination ? Number(amount) : 0)),
      preTokenBalances: balances(false), postTokenBalances: balances(true), innerInstructions: inner.map(g => ({ index: g.index,
        instructions: g.instructions.map(({ instruction: ix, stackHeight }) => ({
          programIdIndex: keys.findIndex(k => k.equals(ix.programId)), accounts: ix.keys.map(a => keys.findIndex(k => k.equals(a.pubkey))),
          data: bs58.encode(ix.data), stackHeight })) })) } } }
}
