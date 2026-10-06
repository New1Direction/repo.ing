// SPIKE ONLY: the Bundle launch mode's on-chain unknowns, on the DBC / DAMM v2 / Metaplex programs exactly as mainnet
// runs them (spike/start-bundle-validator.sh, a local validator). Nothing here touches mainnet beyond the validator
// script reading those programs once.
//   (build program/ first: see README.md) node spikes/bundle-launch/bundle-spike.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BN from 'bn.js'
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram,
  Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, SwapMode, deriveDammV2PoolAddress, deriveDbcEventAuthority,
  deriveDbcPoolAddress, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, SwapMode as AmmSwapMode } from '@meteora-ag/cp-amm-sdk'
import { buildLaunchCurve } from '../../src/launch-curve.mjs'

const RPC = `http://127.0.0.1:${process.env.EARLY_ACCESS_VALIDATOR_RPC_PORT ?? 8929}`
const PROGRAM = new PublicKey('7Yx7Ueyu2tsLWZUzDZVET3Dm3Q45HjQthKYwpQkhTvQj')
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const DAMM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const SOL = 1_000_000_000n, SUPPLY = 10n ** 15n
const MAX = new BN('18446744073709551615')
const results = {}

// Anchor encoding for the spike program.
const disc = name => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b }
const vec = data => { const b = Buffer.alloc(4); b.writeUInt32LE(data.length); return Buffer.concat([b, data]) }
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0]
const bundleAddress = id => pda(Buffer.from('bundle'), u64(id))
const vaultAddress = bundle => pda(Buffer.from('vault'), bundle.toBuffer())
const ROUTER = pda(Buffer.from('router'))
const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true })
const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false })
const ix = (name, keys, data = Buffer.alloc(0)) => new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([disc(name), data]) })
const createBundleIx = (admin, id, launchSigner) => ix('create_bundle', [w(admin, true), w(bundleAddress(id)), r(SystemProgram.programId)],
  Buffer.concat([u64(id), launchSigner.toBuffer()]))
const depositIx = (backer, bundle, lamports) => ix('deposit', [w(backer, true), w(bundle), r(SystemProgram.programId)], u64(lamports))
const releaseIx = (bundle, signer, lamports) => ix('release', [w(bundle), w(signer, true), r(SYSVAR_INSTRUCTIONS_PUBKEY)], u64(lamports))
const settleIx = (bundle, signer, vaultTokens, min) => ix('settle', [w(bundle), r(signer, true), r(vaultTokens)], u64(min))
// One DBC / DAMM v2 call signed by a PDA of the spike program: the call's accounts follow, the PDA's signer flag dropped.
const wrapped = (name, head, inner, signer) => ix(name, [...head, r(inner.programId),
  ...inner.keys.map(key => ({ ...key, isSigner: key.pubkey.equals(signer) ? false : key.isSigner }))], vec(inner.data))
const vaultInvokeIx = (operator, bundle, inner) => wrapped('vault_invoke', [r(operator, true), r(bundle)], inner, vaultAddress(bundle))
const routerInvokeIx = (caller, inner) => wrapped('router_invoke', [r(caller, true)], inner, ROUTER)
const decodeBundle = data => ({ raised: data.readBigUInt64LE(80), released: data.readBigUInt64LE(88), vaultTokens: data.readBigUInt64LE(96) })

// The SDK builds calls for a normal wallet. For a PDA, keep only the program call itself and the account creations a
// real wallet pays for; drop what would need the PDA to sign outside the call (SOL wraps, unwraps).
function onlyCall(tx, programId, payer) {
  const keep = tx.instructions.filter(i => i.programId.equals(programId) ||
    (i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && i.keys[0].pubkey.equals(payer)))
  const calls = keep.filter(i => i.programId.equals(programId))
  assert.equal(calls.length, 1, `one ${programId.toBase58().slice(0, 4)} call in ${tx.instructions.map(i => i.programId.toBase58().slice(0, 4))}`)
  return { setup: keep.filter(i => !i.programId.equals(programId)), call: calls[0] }
}

async function flow(connection) {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed'), amm = new CpAmm(connection)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
  const airdrop = async (to, lamports) => {
    const signature = await connection.requestAirdrop(to, Number(lamports))
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  }
  const funded = async sol => { const keypair = Keypair.generate(); await airdrop(keypair.publicKey, BigInt(sol) * SOL); return keypair }
  const refusal = async run => {
    try { await run() } catch (error) {
      const logs = error?.logs ?? await error?.getLogs?.(connection).catch(() => []) ?? []
      return logs.join('\n').match(/Error Code: (\w+)/)?.[1] ?? String(error?.message ?? error).match(/custom program error: 0x[0-9a-f]+/)?.[0] ?? String(error).slice(0, 300)
    }
    return 'landed'
  }
  const units = async signature => (await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).meta.computeUnitsConsumed
  const tokens = async account => BigInt((await connection.getTokenAccountBalance(account).catch(() => ({ value: { amount: '0' } }))).value.amount)
  const sendV0 = async (instructions, payer, signers, lookup) => {
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: (await connection.getLatestBlockhash()).blockhash, instructions })
      .compileToV0Message(lookup ? [lookup] : [])
    const tx = new VersionedTransaction(message)
    tx.sign(signers)
    const bytes = tx.serialize().length
    const signature = await connection.sendTransaction(tx, { skipPreflight: false })
    const confirmation = await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
    if (confirmation.value.err) throw Object.assign(new Error(JSON.stringify(confirmation.value.err)), { logs: (await connection.getTransaction(signature,
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages })
    return { signature, bytes }
  }

  // repo.ing's launch co-signer is the launch signer and the bundle admin (operator) here.
  const creator = await funded(5), launcher = await funded(5), partnerPayer = await funded(5)
  const backerA = await funded(15), backerB = await funded(10), trader = await funded(30), whale = await funded(400), outsider = await funded(2)

  // 1. The bundle config: today's launch-fee curve, its fee claimer the router PDA (an address, no signature at creation).
  const config = Keypair.generate()
  await send(await dbc.partner.createConfig({ config: config.publicKey, feeClaimer: ROUTER, leftoverReceiver: partnerPayer.publicKey,
    payer: partnerPayer.publicKey, quoteMint: NATIVE_MINT, ...buildLaunchCurve('launch-fee') }), [partnerPayer, config])
  const fixed = await dbc.state.getPoolConfig(config.publicKey)
  assert.ok(fixed.feeClaimer.equals(ROUTER))
  results.config = { feeClaimerIsRouterPda: true, enableFirstSwapWithMinFee: Number(fixed.enableFirstSwapWithMinFee) }

  // 2. The raise: two backers, 20 SOL in the bundle account.
  const ID = 1, bundle = bundleAddress(ID), vault = vaultAddress(bundle)
  await send(new Transaction().add(createBundleIx(creator.publicKey, ID, creator.publicKey)), [creator])
  await send(new Transaction().add(depositIx(backerA.publicKey, bundle, 12n * SOL)), [backerA])
  await send(new Transaction().add(depositIx(backerB.publicKey, bundle, 8n * SOL)), [backerB])
  assert.equal(decodeBundle((await connection.getAccountInfo(bundle)).data).raised, 20n * SOL)

  // 3. The launch: release 19 SOL → DBC pool → the launch signer's top-level first swap with the vault as receiver → settle.
  const RELEASE = 19n * SOL
  const quote = eligible => BigInt(dbc.pool.getQuoteFromInputAmount({ config: fixed, swapBaseForQuote: false, amountIn: new BN(RELEASE.toString()),
    slippageBps: 0, hasReferral: false, eligibleForFirstSwapWithMinFee: eligible }).outputAmount.toString())
  const minFeeOut = quote(true), launchFeeOut = quote(false)
  const mint = Keypair.generate(), pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config.publicKey)
  const vaultTokens = getAssociatedTokenAddressSync(mint.publicKey, vault, true), vaultSol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true)
  const created = await dbc.creator.createPoolWithFirstBuy({
    createPoolParam: { baseMint: mint.publicKey, config: config.publicKey, name: 'Bundle Spike', symbol: 'BNDL', uri: 'https://repo.ing/bundle.json',
      payer: launcher.publicKey, poolCreator: creator.publicKey },
    firstBuyParam: { buyer: creator.publicKey, receiver: vault, buyAmount: new BN(RELEASE.toString()), minimumAmountOut: new BN(minFeeOut.toString()),
      referralTokenAccount: null } })
  results.launchSdkInstructions = created.instructions.map(i => i.programId.toBase58().slice(0, 6))
  const launchInstructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), releaseIx(bundle, creator.publicKey, RELEASE),
    ...created.instructions.filter(i => !i.programId.equals(ComputeBudgetProgram.programId)),
    settleIx(bundle, creator.publicKey, vaultTokens, minFeeOut)]
  let legacyBytes = null
  try {
    legacyBytes = new Transaction({ feePayer: launcher.publicKey, ...await connection.getLatestBlockhash() }).add(...launchInstructions)
      .serialize({ requireAllSignatures: false, verifySignatures: false }).length
  } catch (error) { legacyBytes = String(error.message).match(/too large: (\d+)/)?.[1] ?? 'too large' }
  const [createTable, table] = AddressLookupTableProgram.createLookupTable({ authority: creator.publicKey, payer: creator.publicKey,
    recentSlot: await connection.getSlot('finalized') })
  await send(new Transaction().add(createTable, AddressLookupTableProgram.extendLookupTable({ payer: creator.publicKey, authority: creator.publicKey,
    lookupTable: table, addresses: [deriveDbcPoolAuthority(), deriveDbcEventAuthority(), DBC, TOKEN_PROGRAM_ID, SystemProgram.programId,
      SYSVAR_INSTRUCTIONS_PUBKEY, NATIVE_MINT, PROGRAM, config.publicKey, ASSOCIATED_TOKEN_PROGRAM_ID, METAPLEX, ComputeBudgetProgram.programId] })), [creator])
  let lookup
  for (let i = 0; i < 40 && !(lookup?.state.addresses.length); i++) { await sleep(250); lookup = (await connection.getAddressLookupTable(table)).value }
  for (let i = 0; i < 40 && await connection.getSlot('confirmed') <= lookup.state.lastExtendedSlot; i++) await sleep(250)

  // Refusals first: no settle → no release; a settle into a token account that is not the vault's → the whole launch fails.
  assert.equal(await refusal(() => send(new Transaction().add(releaseIx(bundle, creator.publicKey, SOL)), [creator])), 'NoSettle')
  const creatorTokens = getAssociatedTokenAddressSync(mint.publicKey, creator.publicKey)
  const wrongSettle = launchInstructions.map(i => i.programId.equals(PROGRAM) && i.data.subarray(0, 8).equals(disc('settle'))
    ? settleIx(bundle, creator.publicKey, creatorTokens, minFeeOut) : i)
  assert.equal(await refusal(() => sendV0(wrongSettle, launcher.publicKey, [launcher, creator, mint], lookup)), 'BadVault')
  assert.equal(await connection.getAccountInfo(pool), null, 'no pool after the refused launch')

  const launched = await sendV0(launchInstructions, launcher.publicKey, [launcher, creator, mint], lookup)
  const held = await tokens(vaultTokens), state = decodeBundle((await connection.getAccountInfo(bundle)).data)
  assert.equal(held, minFeeOut, 'the vault got exactly the minimum-fee quote')
  assert.deepEqual([state.released, state.vaultTokens], [RELEASE, held])
  assert.equal(await tokens(creatorTokens), 0n, 'nothing stayed with the launch signer')
  results.launch = { legacyBytes, v0Bytes: launched.bytes, computeUnits: await units(launched.signature), released: `${Number(RELEASE) / 1e9} SOL`,
    vaultShareOfSupply: `${(Number(held) / Number(SUPPLY) * 100).toFixed(2)}%`, minFeeQuote: minFeeOut.toString(), launchFeeQuote: launchFeeOut.toString() }
  assert.equal(await refusal(() => sendV0([releaseIx(bundle, creator.publicKey, 2n * SOL), settleIx(bundle, creator.publicKey, vaultTokens, 1n)],
    creator.publicKey, [creator])), 'TooMuch', 'only the 1 SOL left in escrow')

  // 4. A first swap by CPI (a vault buying at launch through the program) pays the launch fee, not the minimum fee.
  {
    const ID2 = 2, bundle2 = bundleAddress(ID2), vault2 = vaultAddress(bundle2), BUY = SOL
    await send(new Transaction().add(createBundleIx(creator.publicKey, ID2, creator.publicKey)), [creator])
    const vault2Sol = getAssociatedTokenAddressSync(NATIVE_MINT, vault2, true)
    await send(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, vault2Sol, vault2, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: vault2Sol, lamports: BUY }), createSyncNativeInstruction(vault2Sol)), [creator])
    const mint2 = Keypair.generate()
    const out = eligible => BigInt(dbc.pool.getQuoteFromInputAmount({ config: fixed, swapBaseForQuote: false, amountIn: new BN(BUY.toString()),
      slippageBps: 0, hasReferral: false, eligibleForFirstSwapWithMinFee: eligible }).outputAmount.toString())
    const build = min => dbc.creator.createPoolWithFirstBuy({
      createPoolParam: { baseMint: mint2.publicKey, config: config.publicKey, name: 'CPI Buy', symbol: 'CPIB', uri: 'https://repo.ing/cpi.json',
        payer: launcher.publicKey, poolCreator: creator.publicKey },
      firstBuyParam: { buyer: vault2, receiver: vault2, buyAmount: new BN(BUY.toString()), minimumAmountOut: new BN(min.toString()), referralTokenAccount: null } })
    const viaCpi = async min => {
      const built = await build(min)
      const dbcCalls = built.instructions.filter(i => i.programId.equals(DBC))
      assert.equal(dbcCalls.length, 2, 'pool initialize + first swap')
      const vault2Tokens = getAssociatedTokenAddressSync(mint2.publicKey, vault2, true)
      return [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), dbcCalls[0],
        createAssociatedTokenAccountIdempotentInstruction(launcher.publicKey, vault2Tokens, vault2, mint2.publicKey),
        vaultInvokeIx(creator.publicKey, bundle2, dbcCalls[1])]
    }
    const asMinFee = await refusal(async () => sendV0(await viaCpi(out(true)), launcher.publicKey, [launcher, creator, mint2], lookup))
    const landed = await sendV0(await viaCpi(1n), launcher.publicKey, [launcher, creator, mint2], lookup)
    const got = await tokens(getAssociatedTokenAddressSync(mint2.publicKey, vault2, true))
    results.cpiFirstSwap = { refusedAtMinFeeQuote: asMinFee, landedWithMinOut1: true, tokensFor1Sol: got.toString(), minFeeQuote: out(true).toString(),
      launchFeeQuote: out(false).toString(), paidLaunchFee: got === out(false), computeUnits: await units(landed.signature) }
  }

  // 5. Public trades, then the vault trades by CPI on DBC (operator only, DBC / DAMM v2 only).
  const traderSwap = async (buying, amount) => send(await dbc.pool.swap({ owner: trader.publicKey, payer: trader.publicKey, pool,
    amountIn: new BN(String(amount)), minimumAmountOut: new BN(0), swapBaseForQuote: !buying, referralTokenAccount: null }), [trader])
  await traderSwap(true, 2n * SOL)
  await traderSwap(false, (await tokens(getAssociatedTokenAddressSync(mint.publicKey, trader.publicKey))) / 2n)
  await send(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, vaultSol, vault, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: vaultSol, lamports: SOL }), createSyncNativeInstruction(vaultSol)), [creator])
  const vaultSwap = async (buying, amount, operator = creator) => {
    const { setup, call } = onlyCall(await dbc.pool.swap({ owner: vault, payer: creator.publicKey, pool, amountIn: new BN(String(amount)),
      minimumAmountOut: new BN(0), swapBaseForQuote: !buying, referralTokenAccount: null }), DBC, creator.publicKey)
    const signature = await send(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...setup,
      vaultInvokeIx(operator.publicKey, bundle, call)), [...new Set([creator, operator])])
    return units(signature)
  }
  const before = [await tokens(vaultTokens), await tokens(vaultSol)]
  const buyUnits = await vaultSwap(true, SOL / 2n)
  const afterBuy = [await tokens(vaultTokens), await tokens(vaultSol)]
  const sellUnits = await vaultSwap(false, afterBuy[0] / 100n)
  const afterSell = [await tokens(vaultTokens), await tokens(vaultSol)]
  assert.ok(afterBuy[0] > before[0] && afterBuy[1] === before[1] - SOL / 2n, 'the vault bought with its own wrapped SOL')
  assert.ok(afterSell[0] < afterBuy[0] && afterSell[1] > afterBuy[1], 'the vault sold into its own wrapped SOL')
  assert.equal(await refusal(() => vaultSwap(true, SOL / 10n, outsider)), 'NotOperator')
  // The pass-through cannot reach the token program (a transfer out of the vault).
  const drain = new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [w(vaultTokens), w(creatorTokens), r(vault, true)],
    data: Buffer.concat([Buffer.from([3]), u64(1n)]) })
  assert.equal(await refusal(() => send(new Transaction().add(vaultInvokeIx(creator.publicKey, bundle, drain)), [creator])), 'BadTarget')
  results.vaultDbc = { buyComputeUnits: buyUnits, sellComputeUnits: sellUnits, operatorOnly: true, otherProgramsRefused: true }

  // 6. The router PDA (the config's fee claimer) claims the partner fees of the pool by CPI.
  const routerSol = getAssociatedTokenAddressSync(NATIVE_MINT, ROUTER, true)
  const claimDbc = async () => {
    const { setup, call } = onlyCall(await dbc.partner.claimPartnerTradingFee({ feeClaimer: ROUTER, payer: partnerPayer.publicKey, pool,
      maxBaseAmount: MAX, maxQuoteAmount: MAX }), DBC, partnerPayer.publicKey)
    return send(new Transaction().add(...setup, routerInvokeIx(partnerPayer.publicKey, call)), [partnerPayer])
  }
  const poolBefore = await dbc.state.getPool(pool)
  const partnerFee = (poolBefore.poolState ?? poolBefore).partnerQuoteFee
  assert.ok(partnerFee, `partnerQuoteFee not in ${Object.keys(poolBefore)}`)
  const owedQuote = BigInt(partnerFee.toString())
  const claimed = await claimDbc()
  results.routerDbcClaim = { owedQuoteLamports: owedQuote.toString(), routerWsolAfter: (await tokens(routerSol)).toString(),
    computeUnits: await units(claimed) }
  assert.equal(await tokens(routerSol), owedQuote, 'the router received the pool\'s partner SOL fees')
  assert.notEqual(await refusal(async () => send(await dbc.partner.claimPartnerTradingFee({ feeClaimer: partnerPayer.publicKey, payer: partnerPayer.publicKey,
    pool, maxBaseAmount: MAX, maxQuoteAmount: MAX }), [partnerPayer])), 'landed', 'a wallet that is not the fee claimer cannot claim')

  // 7. Graduation with the vault holding ~40% of the supply; the partner LP position goes to the router PDA.
  await send(await dbc.pool.swap2({ owner: whale.publicKey, payer: whale.publicKey, pool, amountIn: new BN(String(300n * SOL)),
    minimumAmountOut: new BN(0), swapBaseForQuote: false, swapMode: SwapMode.PartialFill, referralTokenAccount: null }), [whale])
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: whale.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: SOL })), [whale])
  const filled = await dbc.state.getPool(pool), fp = filled.poolState ?? filled
  results.curveAtMigration = { quoteReserve: fp.quoteReserve?.toString(), threshold: fixed.migrationQuoteThreshold?.toString(),
    migrationProgress: fp.migrationProgress ?? fp.isMigrated, whaleTokens: (await tokens(getAssociatedTokenAddressSync(mint.publicKey, whale.publicKey))).toString() }
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[fixed.migrationFeeOption]
  const migration = await dbc.migration.migrateToDammV2({ pool, dammConfig, payer: whale.publicKey })
  await send(migration.transaction, [whale, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair])
  const dammPool = deriveDammV2PoolAddress(dammConfig, mint.publicKey, NATIVE_MINT)
  const poolState = await amm.fetchPoolState(dammPool)
  const routerPositions = await amm.getPositionsByUser(ROUTER), creatorPositions = await amm.getPositionsByUser(creator.publicKey)
  results.graduation = { vaultShareAtGraduation: `${(Number(await tokens(vaultTokens)) / Number(SUPPLY) * 100).toFixed(2)}%`,
    routerPositions: routerPositions.length, creatorPositions: creatorPositions.length }
  assert.equal(routerPositions.length, 1, 'the partner LP position belongs to the router PDA')

  // 8. DAMM v2: public trades, the vault trades by CPI, the router claims its position's fees by CPI.
  const ammTokens = { tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID }
  const ammSwap = (payer, buying, amount) => amm.swap2({ payer, pool: dammPool, poolState, swapMode: AmmSwapMode.ExactIn,
    inputTokenMint: buying ? NATIVE_MINT : mint.publicKey, outputTokenMint: buying ? mint.publicKey : NATIVE_MINT, ...ammTokens,
    referralTokenAccount: null, amountIn: new BN(String(amount)), minimumAmountOut: new BN(1) })
  await send(await ammSwap(trader.publicKey, true, 3n * SOL), [trader])
  await send(await ammSwap(trader.publicKey, false, (await tokens(getAssociatedTokenAddressSync(mint.publicKey, trader.publicKey))) / 2n), [trader])
  const vaultAmm = async (buying, amount) => {
    const { setup, call } = onlyCall(await ammSwap(vault, buying, amount), DAMM, creator.publicKey)
    return units(await send(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...setup,
      vaultInvokeIx(creator.publicKey, bundle, call)), [creator]))
  }
  const ammBefore = [await tokens(vaultTokens), await tokens(vaultSol)]
  const ammSellUnits = await vaultAmm(false, ammBefore[0] / 200n)
  const ammMid = [await tokens(vaultTokens), await tokens(vaultSol)]
  const ammBuyUnits = await vaultAmm(true, (ammMid[1] - ammBefore[1]) / 2n)
  const ammAfter = [await tokens(vaultTokens), await tokens(vaultSol)]
  assert.ok(ammMid[0] < ammBefore[0] && ammMid[1] > ammBefore[1] && ammAfter[0] > ammMid[0], 'the vault sold and bought on DAMM v2')
  const [position] = routerPositions
  const routerBefore = await tokens(routerSol)
  const { setup, call } = onlyCall(await amm.claimPositionFee({ owner: ROUTER, position: position.position, pool: dammPool,
    positionNftAccount: position.positionNftAccount, ...ammTokens, feePayer: partnerPayer.publicKey }), DAMM, partnerPayer.publicKey)
  const ammClaim = await send(new Transaction().add(...setup, routerInvokeIx(partnerPayer.publicKey, call)), [partnerPayer])
  const routerGain = await tokens(routerSol) - routerBefore
  assert.ok(routerGain > 0n, 'the router claimed SOL fees from its LP position')
  results.damm = { vaultSellComputeUnits: ammSellUnits, vaultBuyComputeUnits: ammBuyUnits, routerClaimedLamports: routerGain.toString(),
    routerClaimComputeUnits: await units(ammClaim) }
}

async function main() {
  assert.match(RPC, /^http:\/\/127\.0\.0\.1:\d+$/, 'a local validator only')
  const work = await mkdtemp(join(tmpdir(), 'repoing-bundle-spike-'))
  const connection = new Connection(RPC, 'confirmed')
  try {
    const run = spawnSync('spikes/bundle-launch/start-spike-validator.sh', [work], { stdio: 'inherit', timeout: 300_000 })
    assert.equal(run.status, 0, 'validator started')
    await flow(connection)
    console.log(JSON.stringify({ ok: true, ...results }, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, ...results }, null, 2))
    console.error(error?.logs?.slice?.(-25)?.join('\n') ?? '')
    throw error
  } finally {
    try { connection._rpcWebSocket?.close() } catch {}
    let pid
    try { pid = Number(await readFile(join(work, 'validator.pid'), 'utf8')) } catch {}
    if (pid) { try { process.kill(pid) } catch {} for (let i = 0; i < 40; i++) { try { process.kill(pid, 0) } catch { break } await new Promise(r => setTimeout(r, 250)) } }
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

await main()
