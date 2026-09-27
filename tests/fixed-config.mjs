import { Keypair, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { buildLaunchCurve } from '../src/launch-curve.mjs'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'

export async function createFixedConfig(connection, profile = 'legacy', options = {}) {
  const partner = Keypair.generate()
  const config = Keypair.generate()
  const airdrop = await connection.requestAirdrop(partner.publicKey, 5_000_000_000)
  await connection.confirmTransaction({ signature: airdrop, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const curve = buildLaunchCurve(profile)
  const tx = await client.partner.createConfig({ config: config.publicKey, feeClaimer: partner.publicKey,
    leftoverReceiver: options.leftoverReceiver ?? partner.publicKey, payer: partner.publicKey, quoteMint: NATIVE_MINT, ...curve })
  tx.feePayer = partner.publicKey
  const signature = await sendAndConfirmTransaction(connection, tx, [partner, config], { commitment: 'confirmed' })
  return { config: config.publicKey, signature, partner }
}
