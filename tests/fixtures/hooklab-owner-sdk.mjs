// Runs the upstream Hook Lab SDK builders (TypeScript, node type stripping) in a disposable
// copy so their output can be compared byte-for-byte with the owner driver's JS ports.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SDK_ROOT = process.env.HOOKLAB_SDK_ROOT ?? path.join(homedir(), 'Documents/ChatGPT/hook-lab-local/sdk')
const repoNodeModules = fileURLToPath(new URL('../../node_modules/', import.meta.url))
export const sdkAvailable = () => existsSync(path.join(SDK_ROOT, 'packages/sdk/src/mainnet-controls.ts'))

const harness = `
import { governanceAction, governanceCommitment, governedSetLaunchConfig, governedSetSwapConfig, initCreatorAuthorization, PRODUCTION_PROGRAMS } from './src/mainnet-controls.ts';
import { PublicKey } from '@solana/web3.js';
const input = JSON.parse(process.argv[2]);
const k = (v: string) => new PublicKey(v);
const ix = (i: any) => ({ programId: i.programId.toBase58(), dataHex: Buffer.from(i.data).toString('hex'), keys: i.keys.map((m: any) => ({ pubkey: m.pubkey.toBase58(), isSigner: m.isSigner, isWritable: m.isWritable })) });
const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const state = (s: any) => ({ ...s, genesis: hex(s.genesis), program: k(s.program), config: k(s.config), revision: BigInt(s.revision),
  roles: Object.fromEntries(Object.entries(s.roles).map(([r, v]) => [r, k(v as string)])), configDigest: hex(s.configDigest), custodyDigest: hex(s.custodyDigest), pendingAdmin: null });
const out: any = {};
out.launchCommitment = Buffer.from(governanceCommitment(state(input.launchState))).toString('hex');
out.swapCommitment = Buffer.from(governanceCommitment(state(input.swapState))).toString('hex');
out.grant = ix(initCreatorAuthorization(k(input.admin), k(input.payer), k(input.creator), { enabled: true, expiresAtSlot: BigInt(input.expiresAtSlot), maxLaunches: BigInt(input.maxLaunches) }, hex(input.expected), PRODUCTION_PROGRAMS.launch));
out.gatesLaunch = ix(governanceAction('launch', k(input.admin), hex(input.expected), { kind: 'setGates', creation: false, trading: false }, PRODUCTION_PROGRAMS));
out.gatesSwap = ix(governanceAction('swap', k(input.admin), hex(input.expected), { kind: 'setGates', creation: false, trading: true }, PRODUCTION_PROGRAMS));
const lc = input.launchArgs;
out.launchConfig = ix(governedSetLaunchConfig(k(input.admin), hex(input.expected), { admin: k(lc.admin), treasury: k(lc.treasury), quoteMint: k(lc.quoteMint),
  launchFeeLamports: BigInt(lc.launchFeeLamports), lpFeeBps: lc.lpFeeBps, maxCreatorFeeBps: lc.maxCreatorFeeBps, sniperWindowSecs: lc.sniperWindowSecs,
  sniperStartBps: lc.sniperStartBps, curveBps: lc.curveBps, supply: BigInt(lc.supply), decimals: lc.decimals, minVirtualQuote: BigInt(lc.minVirtualQuote),
  maxVirtualQuote: BigInt(lc.maxVirtualQuote), paused: lc.paused, ruleBounds: lc.ruleBounds }, PRODUCTION_PROGRAMS.launch));
const sc = input.swapArgs;
out.swapConfig = ix(governedSetSwapConfig(k(input.admin), hex(input.expected), { admin: k(sc.admin), protocolFeeBps: sc.protocolFeeBps, feeCollector: k(sc.feeCollector),
  treasury: k(sc.treasury), poolCreationFeeLamports: BigInt(sc.poolCreationFeeLamports), paused: sc.paused, launchProtocolShareBps: sc.launchProtocolShareBps }, PRODUCTION_PROGRAMS.swap));
console.log(JSON.stringify(out));
`

/** Returns the SDK builders' outputs for the given inputs. Throws if the SDK checkout is absent. */
export function runSdk(input) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hooklab-owner-sdk-'))
  try {
    const pkg = path.join(dir, 'pkg')
    mkdirSync(path.join(pkg, 'node_modules/@bordrless'), { recursive: true })
    cpSync(path.join(SDK_ROOT, 'packages/sdk/src'), path.join(pkg, 'src'), { recursive: true })
    cpSync(path.join(SDK_ROOT, 'packages/sdk/idl'), path.join(pkg, 'idl'), { recursive: true })
    for (const name of ['@anchor-lang', '@solana', 'bn.js']) symlinkSync(path.join(repoNodeModules, name), path.join(pkg, 'node_modules', name))
    symlinkSync(path.join(SDK_ROOT, 'packages/shared'), path.join(pkg, 'node_modules/@bordrless/shared'))
    writeFileSync(path.join(pkg, 'package.json'), '{"type":"module"}')
    writeFileSync(path.join(pkg, 'harness.ts'), harness)
    const stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(pkg, 'harness.ts'), JSON.stringify(input)], { cwd: pkg, encoding: 'utf8' })
    return JSON.parse(stdout.trim().split('\n').pop())
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
