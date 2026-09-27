import assert from 'node:assert/strict'
import { buildLaunchCurve } from '../src/launch-curve.mjs'
import { writeFileSync } from 'node:fs'
import BN from 'bn.js'
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { ACCOUNT_SIZE, getAccount, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk'
import {
  ActivationType,
  BaseFeeMode,
  buildCurveWithCustomSqrtPrices,
  CollectFeeMode,
  createSqrtPrices,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDammV2PoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  SwapMode as DbcSwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpc)) {
  throw new Error('This disposable spike is restricted to a local validator')
}
const baseFeeBps = Number(process.env.SPIKE_BASE_FEE_BPS ?? 100)
const creatorFeePercent = Number(process.env.SPIKE_CREATOR_PERCENT ?? 50)
if (!Number.isInteger(baseFeeBps) || baseFeeBps < 1 || baseFeeBps > 10_000 ||
    !Number.isInteger(creatorFeePercent) || creatorFeePercent < 0 || creatorFeePercent > 100) {
  throw new Error('Invalid local spike fee settings')
}

const connection = new Connection(rpc, 'confirmed')
const client = new DynamicBondingCurveClient(connection, 'confirmed')
const partner = Keypair.generate()
const launcher = Keypair.generate()
const creator = Keypair.generate()
const traderA = Keypair.generate()
const traderB = Keypair.generate()
const receiver = Keypair.generate()
const config = Keypair.generate()
const baseMint = Keypair.generate()
const secondMint = Keypair.generate()
const pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, config.publicKey)
const secondPool = deriveDbcPoolAddress(NATIVE_MINT, secondMint.publicKey, config.publicKey)
const evidence = {
  rpc,
  sdk: '@meteora-ag/dynamic-bonding-curve-sdk@1.5.13',
  roles: Object.fromEntries(
    Object.entries({ partner, launcher, creator, traderA, traderB, receiver })
      .map(([name, keypair]) => [name, keypair.publicKey.toBase58()]),
  ),
  config: config.publicKey.toBase58(),
  mint: baseMint.publicKey.toBase58(),
  pool: pool.toBase58(),
  secondMint: secondMint.publicKey.toBase58(),
  secondPool: secondPool.toBase58(),
  signatures: {},
  feeSettings: { baseFeeBps, creatorFeePercent, dynamicFeeEnabled: false },
  fees: {},
  balances: {},
}

const asString = (value) => value.toString()
const feeSnapshot = async () => {
  const state = await client.state.getPool(pool)
  assert(state, 'pool state missing')
  const breakdown = await client.state.getPoolFeeBreakdown(pool)
  const mapFee = (part) => Object.fromEntries(
    Object.entries(part).map(([name, value]) => [name, asString(value)]),
  )
  return {
    creator: mapFee(breakdown.creator),
    partner: mapFee(breakdown.partner),
    metrics: {
      totalTradingBaseFee: asString(state.poolState.metrics.totalTradingBaseFee),
      totalTradingQuoteFee: asString(state.poolState.metrics.totalTradingQuoteFee),
      totalProtocolBaseFee: asString(state.poolState.metrics.totalProtocolBaseFee),
      totalProtocolQuoteFee: asString(state.poolState.metrics.totalProtocolQuoteFee),
      protocolBaseFee: asString(state.poolState.protocolBaseFee),
      protocolQuoteFee: asString(state.poolState.protocolQuoteFee),
      creatorBaseFee: asString(state.poolState.creatorBaseFee),
      creatorQuoteFee: asString(state.poolState.creatorQuoteFee),
      partnerBaseFee: asString(state.poolState.partnerBaseFee),
      partnerQuoteFee: asString(state.poolState.partnerQuoteFee),
      quoteReserve: asString(state.poolState.quoteReserve),
      isMigrated: state.poolState.isMigrated,
    },
  }
}
const send = async (name, tx, signers) => {
  tx.feePayer = signers[0].publicKey
  const signature = await sendAndConfirmTransaction(connection, tx, signers, {
    commitment: 'confirmed',
  })
  evidence.signatures[name] = signature
  console.log(`${name}: ${signature}`)
  return signature
}
const fund = async (name, keypair, sol = 5) => {
  const signature = await connection.requestAirdrop(keypair.publicKey, sol * 1e9)
  const latest = await connection.getLatestBlockhash('confirmed')
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
  evidence.signatures[`airdrop_${name}`] = signature
}
const save = () => {
  const output = process.env.SPIKE_OUTPUT ?? '/tmp/gitfun-meteora-spike-output.json'
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log(`evidence: ${output}`)
}

try {
  for (const [name, keypair] of Object.entries({ partner, launcher, creator, traderA, traderB })) {
    await fund(name, keypair)
  }

  const sqrtPrices = createSqrtPrices(
    [0.000000001, 0.00000000105, 0.000000002, 0.000001],
    TokenDecimal.SIX,
    TokenDecimal.NINE,
  )
  const curve = process.env.SPIKE_CURVE_PROFILE ? buildLaunchCurve(process.env.SPIKE_CURVE_PROFILE) : buildCurveWithCustomSqrtPrices({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 1000,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: baseFeeBps,
          endingFeeBps: baseFeeBps,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: creatorFeePercent,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    sqrtPrices,
    liquidityWeights: [2, 1, 1],
  })

  if (process.env.SPIKE_CURVE_PROFILE) {
    assert.equal(baseFeeBps, 175, 'Reviewed profiles require the production 175 bps fee')
    assert.equal(creatorFeePercent, 71, 'Reviewed profiles require the production creator share')
    evidence.curveProfile = process.env.SPIKE_CURVE_PROFILE
  }
  const configTx = await client.partner.createConfig({
    config: config.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
    payer: partner.publicKey,
    quoteMint: NATIVE_MINT,
    ...curve,
  })
  await send('create_config', configTx, [partner, config])
  const configState = await client.state.getPoolConfig(config.publicKey)
  evidence.configParameters = {
    creatorTradingFeePercentage: configState.creatorTradingFeePercentage,
    migrationQuoteThreshold: configState.migrationQuoteThreshold.toString(),
    creatorPermanentLockedLiquidityPercentage: configState.creatorPermanentLockedLiquidityPercentage,
    partnerPermanentLockedLiquidityPercentage: configState.partnerPermanentLockedLiquidityPercentage,
  }

  const launch = async (name, mint) => {
    const tx = await client.creator.createPool({
      baseMint: mint.publicKey,
      config: config.publicKey,
      name: name === 'create_pool' ? 'Repo Spike A' : 'Repo Spike B',
      symbol: 'RSPK',
      uri: 'https://example.com/meteora-spike.json',
      payer: launcher.publicKey,
      poolCreator: creator.publicKey,
    })
    await send(name, tx, [launcher, creator, mint])
  }
  await launch('create_pool', baseMint)
  await launch('create_second_pool_same_config', secondMint)
  assert(await client.state.getPool(pool), 'first pool missing')
  assert(await client.state.getPool(secondPool), 'second pool missing')
  evidence.fees.beforeTrades = await feeSnapshot()

  const swap = async (name, wallet, amountIn, sell) => {
    const tx = await client.pool.swap({
      owner: wallet.publicKey,
      payer: wallet.publicKey,
      pool,
      amountIn: new BN(amountIn.toString()),
      minimumAmountOut: new BN(1),
      swapBaseForQuote: sell,
      referralTokenAccount: null,
    })
    await send(name, tx, [wallet])
    evidence.fees[name] = await feeSnapshot()
  }
  await swap('trader_a_buy', traderA, 100_000_000, false)
  await swap('trader_b_buy', traderB, 150_000_000, false)

  const ataA = getAssociatedTokenAddressSync(baseMint.publicKey, traderA.publicKey)
  const tokenA = await getAccount(connection, ataA)
  evidence.balances.traderABaseBeforeSell = tokenA.amount.toString()
  const sellAmount = tokenA.amount / 2n
  assert(sellAmount > 0n, 'trader A has no base token to sell')
  await swap('trader_a_sell', traderA, sellAmount, true)
  evidence.balances.traderABaseAfterSell = (await getAccount(connection, ataA)).amount.toString()

  const before = evidence.fees.trader_a_sell.creator.unclaimedQuoteFee
  assert(BigInt(before) > 0n, 'no creator quote fee accrued')
  evidence.balances.receiverBeforeClaim = String(await connection.getBalance(receiver.publicKey))
  const claimTx = await client.creator.claimCreatorTradingFeeToReceiver({
    creator: creator.publicKey,
    payer: creator.publicKey,
    pool,
    maxBaseAmount: new BN(0),
    maxQuoteAmount: new BN('18446744073709551615'),
    receiver: receiver.publicKey,
  })
  await send('claim_creator_to_receiver', claimTx, [creator])
  evidence.fees.afterClaim = await feeSnapshot()
  evidence.balances.receiverAfterClaim = String(await connection.getBalance(receiver.publicKey))
  evidence.balances.receiverRentRefund = String(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE))
  assert.equal(
    BigInt(evidence.balances.receiverAfterClaim) - BigInt(evidence.balances.receiverBeforeClaim),
    BigInt(before) - BigInt(evidence.fees.afterClaim.creator.unclaimedQuoteFee) + BigInt(evidence.balances.receiverRentRefund),
    'receiver delta must equal claimed creator fee plus temporary WSOL account rent refund',
  )
  assert.equal(evidence.fees.afterClaim.creator.unclaimedQuoteFee, '0')

  if (process.env.SPIKE_MIGRATE === '1') {
    evidence.migration = { dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100].toBase58() }
    try {
      await fund('traderB_migration', traderB, Math.ceil(Number(configState.migrationQuoteThreshold.toString()) / 1e9 * 2 + 10))
      await swap('migration_buy', traderB, 29_000_000_000, false)
      const afterLargeBuy = await client.state.getPool(pool)
      const deficit = BigInt(configState.migrationQuoteThreshold.toString()) - BigInt(afterLargeBuy.poolState.quoteReserve.toString())
      if (deficit > 0n) {
        // Partial fill reaches the reserve threshold using the actual fixed
        // fee. The old 1% gross-up did not complete a curve with a 1.75% fee.
        const finish = await client.pool.swap2({ owner: traderB.publicKey, payer: traderB.publicKey,
          pool, amountIn: new BN((deficit * 2n).toString()), minimumAmountOut: new BN(1),
          swapBaseForQuote: false, swapMode: DbcSwapMode.PartialFill, referralTokenAccount: null })
        await send('migration_finish_buy', finish, [traderB])
      }
      const beforeMigration = await client.state.getPool(pool)
      assert(beforeMigration.poolState.quoteReserve.gte(configState.migrationQuoteThreshold))
      evidence.migration.before = {
        quoteReserve: beforeMigration.poolState.quoteReserve.toString(),
        isMigrated: beforeMigration.poolState.isMigrated,
      }
      const poolAuthority = deriveDbcPoolAuthority()
      evidence.migration.poolAuthority = poolAuthority.toBase58()
      if ((await connection.getBalance(poolAuthority)) < 1_000_000_000) {
        const fundAuthorityTx = new Transaction().add(SystemProgram.transfer({
          fromPubkey: launcher.publicKey,
          toPubkey: poolAuthority,
          lamports: 1_000_000_000,
        }))
        await send('fund_pool_authority_for_local_migration', fundAuthorityTx, [launcher])
      }
      const result = await client.migration.migrateToDammV2({
        payer: launcher.publicKey,
        pool,
        dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100],
      })
      await send('migrate_to_damm_v2', result.transaction, [launcher, result.firstPositionNftKeypair, result.secondPositionNftKeypair])
      evidence.migration.firstPositionNftMint = result.firstPositionNftKeypair.publicKey.toBase58()
      evidence.migration.secondPositionNftMint = result.secondPositionNftKeypair.publicKey.toBase58()
      const afterMigration = await client.state.getPool(pool)
      assert.equal(afterMigration.poolState.isMigrated, 1)
      evidence.migration.after = {
        quoteReserve: afterMigration.poolState.quoteReserve.toString(),
        isMigrated: afterMigration.poolState.isMigrated,
      }
      evidence.fees.afterMigration = await feeSnapshot()
      const dbcFeeAfterMigration = evidence.fees.afterMigration.creator.unclaimedQuoteFee
      evidence.migration.creatorDbcFeeAfterMigration = dbcFeeAfterMigration
      if (BigInt(dbcFeeAfterMigration) > 0n) {
        const receiverBefore = await connection.getBalance(receiver.publicKey)
        const postMigrationDbcClaim = await client.creator.claimCreatorTradingFeeToReceiver({
          creator: creator.publicKey,
          payer: creator.publicKey,
          pool,
          maxBaseAmount: new BN(0),
          maxQuoteAmount: new BN('18446744073709551615'),
          receiver: receiver.publicKey,
        })
        await send('claim_remaining_dbc_fee_after_migration', postMigrationDbcClaim, [creator])
        evidence.fees.afterPostMigrationDbcClaim = await feeSnapshot()
        evidence.migration.receiverDeltaFromPostMigrationDbcClaim = String((await connection.getBalance(receiver.publicKey)) - receiverBefore)
        assert.equal(evidence.fees.afterPostMigrationDbcClaim.creator.unclaimedQuoteFee, '0')
        assert.equal(
          BigInt(evidence.migration.receiverDeltaFromPostMigrationDbcClaim),
          BigInt(dbcFeeAfterMigration) + BigInt(evidence.balances.receiverRentRefund),
        )
      }
      const dammPool = deriveDammV2PoolAddress(
        DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100],
        baseMint.publicKey,
        NATIVE_MINT,
      )
      evidence.migration.dammPool = dammPool.toBase58()
      const cpAmm = new CpAmm(connection)
      const dammState = await cpAmm.fetchPoolState(dammPool)
      const positionNftMint = result.firstPositionNftKeypair.publicKey
      const position = derivePositionAddress(positionNftMint)
      const positionNftAccount = derivePositionNftAccount(positionNftMint)
      const nft = await getAccount(connection, positionNftAccount, 'confirmed', TOKEN_2022_PROGRAM_ID)
      evidence.migration.creatorPosition = position.toBase58()
      evidence.migration.creatorPositionNftAccount = positionNftAccount.toBase58()
      evidence.migration.creatorPositionOwner = nft.owner.toBase58()
      assert.equal(nft.owner.toBase58(), creator.publicKey.toBase58())
      const positionBefore = await cpAmm.fetchPositionState(position)
      const partnerPosition = await cpAmm.fetchPositionState(derivePositionAddress(result.secondPositionNftKeypair.publicKey))
      assert(positionBefore.permanentLockedLiquidity.gt(new BN(0)))
      const lockedTotal = positionBefore.permanentLockedLiquidity.add(partnerPosition.permanentLockedLiquidity)
      const creatorLockedBps = positionBefore.permanentLockedLiquidity.muln(10_000).div(lockedTotal).toNumber()
      // Token-to-liquidity rounding makes the two raw Q64 positions slightly
      // unequal, even with a 50/50 config. At most one raw unit remains unlocked.
      assert(Math.abs(creatorLockedBps - 5000) <= 1)
      assert(positionBefore.unlockedLiquidity.lten(1) && partnerPosition.unlockedLiquidity.lten(1))
      evidence.migration.lockedSplit = { creatorBps: creatorLockedBps,
        creator: positionBefore.permanentLockedLiquidity.toString(), partner: partnerPosition.permanentLockedLiquidity.toString(),
        creatorUnlockedRaw: positionBefore.unlockedLiquidity.toString(), partnerUnlockedRaw: partnerPosition.unlockedLiquidity.toString() }
      evidence.migration.creatorPositionBeforeTrade = {
        feeAPending: positionBefore.feeAPending.toString(),
        feeBPending: positionBefore.feeBPending.toString(),
        permanentLockedLiquidity: positionBefore.permanentLockedLiquidity.toString(),
      }
      const dammSwap = await cpAmm.swap2({
        payer: traderA.publicKey,
        pool: dammPool,
        inputTokenMint: NATIVE_MINT,
        outputTokenMint: baseMint.publicKey,
        tokenAMint: dammState.tokenAMint,
        tokenBMint: dammState.tokenBMint,
        tokenAVault: dammState.tokenAVault,
        tokenBVault: dammState.tokenBVault,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        swapMode: SwapMode.ExactIn,
        amountIn: new BN(100_000_000),
        minimumAmountOut: new BN(1),
      })
      await send('damm_v2_buy', dammSwap, [traderA])
      const positionAfterTrade = await cpAmm.fetchPositionState(position)
      evidence.migration.creatorPositionAfterTrade = {
        feeAPending: positionAfterTrade.feeAPending.toString(),
        feeBPending: positionAfterTrade.feeBPending.toString(),
      }
      evidence.balances.receiverBeforeDammClaim = String(await connection.getBalance(receiver.publicKey))
      const dammClaim = await cpAmm.claimPositionFee2({
        owner: creator.publicKey,
        position,
        pool: dammPool,
        positionNftAccount,
        tokenAMint: dammState.tokenAMint,
        tokenBMint: dammState.tokenBMint,
        tokenAVault: dammState.tokenAVault,
        tokenBVault: dammState.tokenBVault,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
        receiver: receiver.publicKey,
        feePayer: creator.publicKey,
      })
      await send('claim_damm_v2_creator_fee_to_receiver', dammClaim, [creator])
      evidence.balances.receiverAfterDammClaim = String(await connection.getBalance(receiver.publicKey))
      const positionAfterClaim = await cpAmm.fetchPositionState(position)
      evidence.migration.creatorPositionAfterClaim = {
        feeAPending: positionAfterClaim.feeAPending.toString(),
        feeBPending: positionAfterClaim.feeBPending.toString(),
        totalClaimedBFee: positionAfterClaim.metrics.totalClaimedBFee.toString(),
      }
      evidence.migration.dammReceiverRentRefund = String(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE))
      assert(BigInt(evidence.migration.creatorPositionAfterClaim.totalClaimedBFee) > 0n)
      assert.equal(
        BigInt(evidence.balances.receiverAfterDammClaim) - BigInt(evidence.balances.receiverBeforeDammClaim),
        BigInt(evidence.migration.creatorPositionAfterClaim.totalClaimedBFee) + BigInt(evidence.migration.dammReceiverRentRefund),
      )
    } catch (error) {
      evidence.migration.error = String(error?.stack ?? error)
      console.error('migration probe failed:', error?.message ?? error)
      throw error
    }
  }
  save()
} catch (error) {
  evidence.error = String(error?.stack ?? error)
  save()
  throw error
}
