import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PublicKey, ComputeBudgetProgram, TransactionMessage } from '@solana/web3.js'
import { curveFixture, curveObservations } from './fixtures/hooklab-curve.mjs'
import { buildCurveInstruction, prepareCurveReview, curveDigest } from '../src/hooklab-curve.mjs'
import { missingArtifactEnv } from './fixtures/hooklab-generated-artifact.mjs'

test('frozen production ELFs execute exact unsigned v0 buy/sell round trips and atomically refuse slippage, pause and placeholder drift',
  { skip: missingArtifactEnv(['HOOKLAB_CURVE_RUNTIME_BINARY'], 'frozen Hook Lab repoing_curve_runtime example; SBF_OUT_DIR must hold the three pinned production ELFs') }, () => {
    const directory = process.env.SBF_OUT_DIR
    for (const [program, sha] of Object.entries({
      bordrless_launch: 'faa3d46728a4848789413c3f55599b116bfa5984e371504e4f56afcccc88f9ec',
      bordrless_swap: 'abda98457f24e5581ba8fe82cbe9caabfb8f39c4323fee8f972046c9003ecc62',
      bordrless_token: '3d6b8dc962b74da69984e783d94da5369d5850584d2e3c6ee525b7a641c81241',
    })) assert.equal(curveDigest(readFileSync(join(directory, `${program}.so`))), sha, `${program} drift`)
    const scratch = mkdtempSync(join(tmpdir(), 'curve-runtime-'))
    try {
      for (const recipientSame of [true, false]) {
        const f = curveFixture({ recipientSame, unsignedOnly: true }), a = f.addresses
        const swap = new PublicKey(f.observed.accounts.pool.owner), token = new PublicKey(f.observed.accounts.traderBase.owner)
        const launch = new PublicKey(f.observed.accounts.launch.owner)
        const bump = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds, program)[1]
        f.fields.swapConfig.values.bump = bump(swap, Buffer.from('config'))
        f.fields.pool.values.bump = bump(swap, Buffer.from('pool'), a.mint.toBuffer(), a.quoteMint.toBuffer(), Buffer.from([0, 0]), launch.toBuffer())
        f.fields.pool.values.hook_signer_bump = bump(swap, Buffer.from('hook-authority'), launch.toBuffer())
        for (const [role, field] of Object.entries(f.fields)) {
          if (field.name === 'Holding') field.values.bump = bump(token, Buffer.from('holding'), field.values.mint.toBuffer(), field.values.owner.toBuffer())
          f.patchAccount(role, {})
        }
        const buy = buildCurveInstruction(f.intent, f.observed), afterBuy = curveObservations(f)[0].history.after
        const sellIntent = { ...f.intent, side: 'sell', trader: f.intent.recipient, recipient: f.intent.trader,
          amountIn: '667', maxInput: '667', minAmountOut: '99' }
        const sellState = { ...f.observed, accounts: afterBuy }
        assert.equal(prepareCurveReview(sellIntent, sellState).candidateOutput, '100')
        const sell = buildCurveInstruction(sellIntent, sellState)
        const run = (accounts, steps) => {
          const lines = [`CONTEXT\t${f.intent.feePayer}\t${f.observed.blockhash}`,
            ...Object.entries(accounts).map(([role, a]) => `ACCOUNT\t${role}\t${a.address}\t${a.owner}\t${Buffer.from(a.dataBase64, 'base64').toString('hex')}`)]
          for (const [ix, success] of steps) {
            const message = new TransactionMessage({ payerKey: f.payer.publicKey, recentBlockhash: f.observed.blockhash,
              instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }), ix] }).compileToV0Message()
            lines.push(`STEP\t${success ? 'ok' : 'refused'}\t${Buffer.from(message.serialize()).toString('hex')}`,
              `HEADER\t${message.header.numRequiredSignatures}\t${message.header.numReadonlySignedAccounts}\t${message.header.numReadonlyUnsignedAccounts}`,
              ...message.staticAccountKeys.map(k => `KEY\t${k.toBase58()}`),
              ...message.compiledInstructions.map(i => `IX\t${i.programIdIndex}\t${Buffer.from(i.accountKeyIndexes).toString('hex')}\t${Buffer.from(i.data).toString('hex')}`), 'END')
          }
          const path = join(scratch, 'input.tsv'); writeFileSync(path, lines.join('\n'))
          const output = execFileSync(process.env.HOOKLAB_CURVE_RUNTIME_BINARY, [path], { encoding: 'utf8', timeout: 60000 })
          const records = output.trim().split('\n').map(line => line.split('\t'))
          for (const row of records.filter(r => r[0] === 'RESULT')) {
            assert.ok(Number(row[3]) > 0 && Number(row[3]) <= 400000)
            assert.equal(BigInt(row[4]) - BigInt(row[5]), 10000n, 'exact two-signer network fee only')
          }
          assert.equal(records.filter(r => r[0] === 'RESULT').length, steps.length)
          return records
        }
        const badBuy = buildCurveInstruction(f.intent, f.observed); badBuy.data.writeBigUInt64LE(668n, 17)
        const badSell = buildCurveInstruction(sellIntent, sellState); badSell.data.writeBigUInt64LE(101n, 17)
        const wrongKit = buildCurveInstruction(f.intent, f.observed); wrongKit.keys[18].pubkey = f.trader.publicKey
        const records = run(f.observed.accounts, [[badBuy, false], [wrongKit, false], [buy, true], [badSell, false], [sell, true]])
        const post = step => Object.fromEntries(records.filter(r => r[0] === 'STATE' && r[1] === String(step)).map(r => [r[2], r[4]]))
        assert.deepEqual(post(2), Object.fromEntries(Object.entries(afterBuy).map(([role, a]) => [role, Buffer.from(a.dataBase64, 'base64').toString('hex')])))
        const expected = structuredClone(f.observed.accounts)
        // Independent round-trip calculation: buy floor(101*80000/12101)=667;
        // sell floor(667*12101/80000)=100. User loses one quote unit to integer rounding.
        f.patchAccount('pool', { base_reserve: 60000, quote_reserve: 9001, swap_count: 9,
          base_volume: 13679, quote_volume: 2546, last_swap_at: 2000 }, expected)
        f.patchAccount('quoteVault', { amount: 9018 }, expected)
        f.patchAccount('traderQuote', { amount: 1999 }, expected)
        assert.deepEqual(post(4), Object.fromEntries(Object.entries(expected).map(([role, a]) => [role, Buffer.from(a.dataBase64, 'base64').toString('hex')])))
        const paused = structuredClone(f.observed.accounts); f.patchAccount('swapConfig', { paused: true }, paused)
        run(paused, [[buy, false]])
      }
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })
