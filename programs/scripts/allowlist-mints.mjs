// Compute per-mint minimum deposits (default ≈ $5) from live Jupiter prices and,
// only with --send, allowlist the mints on DEVNET / a local validator.
//
// DRY-RUN BY DEFAULT: prints the computed raw minimums for review and exits.
//
//   node programs/scripts/allowlist-mints.mjs                    # dry run, all defaults
//   node programs/scripts/allowlist-mints.mjs --usd 5 SPYx USDC  # dry run, subset
//   DEVNET_RPC_URL=https://api.devnet.solana.com ALLOWLIST_KEYPAIR=path.json \
//     node programs/scripts/allowlist-mints.mjs --send --mint SPYx=<devnet test mint> SPYx
//
// Prices always come from the mainnet mint (read-only HTTP). --mint SYMBOL=ADDRESS
// substitutes the mint that is allowlisted on the target cluster (devnet test mints);
// its decimals must match the mainnet mint's or the script refuses.
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

const PROGRAM_ID = new PublicKey('EYWsnGsXdyozWYuTY2CxYjCrPxyDFHvhxarn2Qcwzv51');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const JUPITER_PRICE_URL = 'https://lite-api.jup.ag/price/v3?ids=';
const DEFAULT_USD = 5;

// Default table. Mints are the official mainnet addresses (xStocks from api.xstocks.fi).
// allowPermanentDelegate: xStocks mints carry an issuer permanent delegate (see design doc).
const DEFAULT_MINTS = [
  { symbol: 'SPYx', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', allowPermanentDelegate: true },
  { symbol: 'NVDAx', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', allowPermanentDelegate: true },
  { symbol: 'TSLAx', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', allowPermanentDelegate: true },
  { symbol: 'QQQx', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', allowPermanentDelegate: true },
  { symbol: 'AAPLx', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', allowPermanentDelegate: true },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', allowPermanentDelegate: false },
  { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', allowPermanentDelegate: false }, // wSOL
];

function parseArgs(argv) {
  const opts = { send: false, usd: DEFAULT_USD, overrides: {}, symbols: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--send') opts.send = true;
    else if (arg === '--usd') opts.usd = Number(argv[(i += 1)]);
    else if (arg === '--mint') {
      const [symbol, address] = String(argv[(i += 1)]).split('=');
      opts.overrides[symbol] = new PublicKey(address).toBase58();
    } else opts.symbols.push(arg);
  }
  if (!Number.isFinite(opts.usd) || opts.usd <= 0) throw new Error('--usd must be a positive number');
  return opts;
}

/** Round a positive integer up to two significant figures (e.g. 652_117 -> 660_000). */
export function roundUpTwoSig(n) {
  if (n <= 0n) return 1n;
  const digits = n.toString().length;
  if (digits <= 2) return n;
  const unit = 10n ** BigInt(digits - 2);
  return ((n + unit - 1n) / unit) * unit;
}

/** Raw base units worth at least `usd`, given a price per UI token and scaled-UI multiplier. */
export function rawMinimum({ usd, usdPrice, decimals, multiplier = 1 }) {
  if (!(usdPrice > 0)) throw new Error('price unavailable');
  // UI amount = raw / 10^decimals * multiplier  =>  raw = usd / (price * multiplier) * 10^decimals
  const exact = (usd / (usdPrice * multiplier)) * 10 ** decimals;
  return roundUpTwoSig(BigInt(Math.ceil(exact)));
}

async function fetchPrices(mints) {
  const res = await fetch(JUPITER_PRICE_URL + mints.join(','), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jupiter price API ${res.status}`);
  return res.json();
}

function formatUi(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals) || '0'}.${s.slice(-decimals)}`.replace(/\.?0+$/, '');
}

async function computeTable(opts) {
  const wanted = opts.symbols.length
    ? DEFAULT_MINTS.filter((m) => opts.symbols.includes(m.symbol))
    : DEFAULT_MINTS;
  if (!wanted.length) throw new Error(`unknown symbols: ${opts.symbols.join(', ')}`);
  const prices = await fetchPrices(wanted.map((m) => m.mint));
  return wanted.map((m) => {
    const p = prices[m.mint];
    if (!p) throw new Error(`no Jupiter price for ${m.symbol}`);
    const multiplier = p.scaledUiConfig?.multiplier ?? 1;
    const minRaw = rawMinimum({ usd: opts.usd, usdPrice: p.usdPrice, decimals: p.decimals, multiplier });
    const uiAmount = Number(formatUi(minRaw, p.decimals)) * multiplier;
    return {
      ...m,
      targetMint: opts.overrides[m.symbol] ?? m.mint,
      decimals: p.decimals,
      usdPrice: p.usdPrice,
      multiplier,
      minRaw,
      minUi: formatUi(minRaw, p.decimals),
      minUsd: uiAmount * p.usdPrice,
    };
  });
}

function printTable(rows, usd) {
  console.log(`Minimum deposits targeting $${usd} (Jupiter price v3, ${new Date().toISOString()}), rounded up to 2 significant figures:\n`);
  console.table(rows.map((r) => ({
    symbol: r.symbol,
    mint: r.targetMint,
    decimals: r.decimals,
    usdPrice: r.usdPrice.toFixed(4),
    uiMultiplier: r.multiplier,
    min_deposit_raw: r.minRaw.toString(),
    min_raw_units_as_ui: r.minUi,
    approx_usd: r.minUsd.toFixed(2),
    allow_permanent_delegate: r.allowPermanentDelegate,
  })));
}

function discriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function u64le(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

async function send(rows) {
  const rpcUrl = process.env.DEVNET_RPC_URL;
  const keypairPath = process.env.ALLOWLIST_KEYPAIR;
  if (!rpcUrl || !keypairPath) throw new Error('--send needs DEVNET_RPC_URL and ALLOWLIST_KEYPAIR');
  const connection = new Connection(rpcUrl, 'confirmed');
  const genesis = await connection.getGenesisHash();
  const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpcUrl);
  if (genesis !== DEVNET_GENESIS && !isLocal) {
    throw new Error(`refusing: ${rpcUrl} is not devnet or a local validator (genesis ${genesis})`);
  }
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))));
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);

  for (const row of rows) {
    const mint = new PublicKey(row.targetMint);
    const info = await connection.getParsedAccountInfo(mint);
    const decimals = info.value?.data?.parsed?.info?.decimals;
    if (!info.value || decimals !== row.decimals) {
      console.error(`skip ${row.symbol}: mint ${mint.toBase58()} missing on target cluster or decimals ${decimals} != ${row.decimals}`);
      continue;
    }
    const [allowedMint] = PublicKey.findProgramAddressSync([Buffer.from('allowed_mint'), mint.toBuffer()], PROGRAM_ID);
    if (await connection.getAccountInfo(allowedMint)) {
      console.log(`skip ${row.symbol}: already allowlisted (remove_allowed_mint first to change the minimum)`);
      continue;
    }
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: allowedMint, isSigner: false, isWritable: true },
        { pubkey: info.value.owner, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        discriminator('add_allowed_mint'),
        u64le(row.minRaw),
        Buffer.from([row.allowPermanentDelegate ? 1 : 0]),
      ]),
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
    console.log(`allowlisted ${row.symbol} ${mint.toBase58()} min=${row.minRaw} sig=${sig}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await computeTable(opts);
  printTable(rows, opts.usd);
  if (!opts.send) {
    console.log('\nDry run: nothing sent. Re-run with --send (devnet/local only) after reviewing the minimums.');
    return;
  }
  await send(rows);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
