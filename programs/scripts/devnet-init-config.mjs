// Initialise the donation escrow config on DEVNET. Called by deploy-devnet.sh.
// Refuses to send unless the RPC's genesis hash is devnet's (or the RPC is a
// local solana-test-validator on 127.0.0.1/localhost, for smoke tests).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM_ID = new PublicKey('EYWsnGsXdyozWYuTY2CxYjCrPxyDFHvhxarn2Qcwzv51');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function discriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

async function main() {
  const rpcUrl = requireEnv('DEVNET_RPC_URL');
  const connection = new Connection(rpcUrl, 'confirmed');
  const genesis = await connection.getGenesisHash();
  const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpcUrl);
  if (genesis !== DEVNET_GENESIS && !isLocal) {
    throw new Error(`refusing: ${rpcUrl} is not devnet (genesis ${genesis})`);
  }

  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(requireEnv('DEPLOYER_KEYPAIR'), 'utf8'))),
  );
  const pick = (name) => new PublicKey(process.env[name] || deployer.publicKey.toBase58());
  const admin = pick('ESCROW_ADMIN');
  const verifier = pick('ESCROW_VERIFIER');
  const allowlist = pick('ESCROW_ALLOWLIST_AUTHORITY');

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
  if (await connection.getAccountInfo(config)) {
    console.log(`config already initialised: ${config.toBase58()}`);
    return;
  }
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: programData, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      discriminator('initialize_config'),
      admin.toBuffer(),
      verifier.toBuffer(),
      allowlist.toBuffer(),
    ]),
  });
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [deployer]);
  console.log(JSON.stringify({
    cluster: isLocal ? 'localnet' : 'devnet',
    program: PROGRAM_ID.toBase58(),
    config: config.toBase58(),
    admin: admin.toBase58(),
    verifier: verifier.toBase58(),
    allowlistAuthority: allowlist.toBase58(),
    signature,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
