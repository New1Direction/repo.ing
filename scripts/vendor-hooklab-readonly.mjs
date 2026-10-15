// Rebuild pinned Hook Lab packages. Optional fresh-candidate mode is isolated and
// undeployed: it must never replace the active read-only package. No chain access.
import { build, version } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fresh = process.argv[3] === 'fresh-candidate'
const hardened = process.argv[3] === 'hardened-candidate'
const production = process.argv[3] === 'production-candidate'
if (process.argv[3] && !fresh && !hardened && !production) throw new Error('Unknown vendoring mode.')
const revision = production ? 'f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32' : hardened ? '826b5a480dfafbe9395f9e9b9c280d07fc7eb809' : fresh ? 'f3c57ccc15f327a65f447f51b6f4b61833de78b7' : '9b3473e001a9abc73bf644d4206e47abc95a815b'
const manifestHash = production ? '9df8e9ceaa3a73fb37c8af35254382f27e38bfc35d6a1fcfa4b72223e75e9cb7' : hardened ? '4352214b2194a70e45f0b2cf16e10e2a62c29b947574b41a5caeff749c9d87f0' : fresh ? '1a0ee482d83587f80af790729733e662ce39096e078b5a18c4e5c7514d7682d4' : '3e904e1030f581d8b79879aaf43a5f3c9d20f63979008c2e4b0799581e14e403'
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = path.resolve(process.argv[2] || '')
const output = path.join(root, production ? 'vendor/hooklab-production-candidate' : hardened ? 'vendor/hooklab-hardened-candidate' : fresh ? 'vendor/hooklab-guarded-candidate' : 'vendor/hooklab-readonly')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
if (!process.argv[2] || git('rev-parse', 'HEAD') !== revision || git('status', '--porcelain', '--untracked-files=no')) {
  throw new Error(`Pass a clean Hook Lab checkout at ${revision}; first install its frozen SDK lockfile and run pnpm -C sdk build.`)
}
if (version !== '0.25.12') throw new Error('esbuild 0.25.12 is required.')
const manifestPath = production ? path.join(source, 'deployments/production/profile.json') : hardened ? path.join(source, 'deployments/hardened-devnet/profile.json') : fresh ? path.join(source, '../candidate/candidate-manifest.json') : path.join(source, 'sdk/packages/sdk/integration/devnet.json')
const manifest = await readFile(manifestPath)
if (sha(manifest) !== manifestHash) throw new Error('Manifest checksum mismatch.')
const idlDirectories = hardened || production ? ['idl', 'idl/guarded-v2', 'idl/mainnet-controls'] : fresh ? ['idl', 'idl/guarded-v2', 'idl/fresh-devnet'] : ['idl']
const idlHashes = {}
for (const directory of idlDirectories) {
  for (const name of (await readdir(path.join(source, 'sdk/packages/sdk', directory))).filter(f => f.endsWith('.json')).sort()) {
    idlHashes[path.posix.join(directory, name)] = sha(await readFile(path.join(source, 'sdk/packages/sdk', directory, name)))
  }
}
await mkdir(path.join(output, 'dist'), { recursive: true })
const result = await build({
  absWorkingDir: source,
  stdin: { contents: production ? `
export { PRODUCTION_PROGRAMS, createLaunchMainnet, mainnetLaunchAddresses,
  creatorAuthorizationAddress, creationControlHash } from './sdk/packages/sdk/src/mainnet-controls.ts';
export { decodeLaunchConfig, decodeSwapConfig, decodeLaunch, decodePool, decodeMint, decodeHolding, NO_LAUNCH_RULES } from './sdk/packages/sdk/src/accounts.ts';
export { encodeHookAccountList } from './sdk/packages/sdk/src/hooks.ts';
export { launchEconomicsHash, poolEconomicsHash } from './sdk/packages/sdk/src/guarded.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function productionCandidateManifest() {
  const expected = ${JSON.stringify({ ...idlHashes, 'integration/candidate.json': manifestHash })};
  for (const [file, hash] of Object.entries(expected)) {
    if (createHash('sha256').update(readFileSync(new URL('../' + file, import.meta.url))).digest('hex') !== hash) throw new Error('Production candidate asset checksum mismatch: ' + file);
  }
  return JSON.parse(readFileSync(new URL('../integration/candidate.json', import.meta.url), 'utf8'));
}
` : hardened ? `
export { HARDENED_DEVNET_PROGRAMS, mainnetLaunchAddresses, governanceAddress,
  creatorAuthorizationAddress, governanceCommitment, creatorAuthorizationHash, creationControlHash } from './sdk/packages/sdk/src/mainnet-controls.ts';
export { quoteLaunchSwap } from './sdk/packages/shared/src/policy.ts';
export { decodeLaunchConfig, decodeSwapConfig, decodeLaunch, decodePool, decodeMint, decodeHolding } from './sdk/packages/sdk/src/accounts.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function hardenedCandidateManifest() {
  const expected = ${JSON.stringify({ ...idlHashes, 'integration/candidate.json': manifestHash })};
  for (const [file, hash] of Object.entries(expected)) {
    if (createHash('sha256').update(readFileSync(new URL('../' + file, import.meta.url))).digest('hex') !== hash) throw new Error('Hardened candidate asset checksum mismatch: ' + file);
  }
  return JSON.parse(readFileSync(new URL('../integration/candidate.json', import.meta.url), 'utf8'));
}
` : fresh ? `
export { FRESH_DEVNET, freshPlainLaunch, freshLaunchAddresses, freshRentInventory } from './sdk/packages/sdk/src/fresh-devnet.ts';
export { launchEconomicsHash, poolEconomicsHash, launchV2Budget } from './sdk/packages/sdk/src/guarded.ts';
export { decodeLaunchConfig, decodeSwapConfig, decodeLaunch, decodePool, decodeMint, decodeHolding, NO_LAUNCH_RULES } from './sdk/packages/sdk/src/accounts.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function freshCandidateManifest() {
  const expected = ${JSON.stringify({ ...idlHashes, 'integration/candidate.json': manifestHash })};
  for (const [file, hash] of Object.entries(expected)) {
    if (createHash('sha256').update(readFileSync(new URL('../' + file, import.meta.url))).digest('hex') !== hash) throw new Error('Fresh candidate asset checksum mismatch: ' + file);
  }
  return JSON.parse(readFileSync(new URL('../integration/candidate.json', import.meta.url), 'utf8'));
}
` : `export { integrationCompatibility, integrationIdlRefusals, inspectDevnetIntegration } from './sdk/packages/sdk/src/integration.ts';
export { integrationCapabilities, previewHookLabIntegration } from './sdk/packages/launcher/src/integration.ts';
import { integrationManifest as upstreamManifest } from './sdk/packages/sdk/src/integration.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// Consumer integrity check stays inside the external Node package so bundlers cannot rewrite its asset URL.
export function integrationManifest() {
  const bytes = readFileSync(new URL('../integration/devnet.json', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== '${manifestHash}') throw new Error('Hook Lab manifest checksum mismatch.');
  return upstreamManifest();
}`, resolveDir: source, sourcefile: 'repoing-readonly-entry.ts' },
  outfile: path.join(output, 'dist/index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['@solana/web3.js'], legalComments: 'external', metafile: true,
  banner: { js: 'import {createRequire as __hooklabCreateRequire} from "node:module";const require=__hooklabCreateRequire(import.meta.url);' },
})
for (const directory of [...idlDirectories, 'integration']) {
  await mkdir(path.join(output, directory), { recursive: true })
  const names = directory.startsWith('idl') ? (await readdir(path.join(source, 'sdk/packages/sdk', directory))).filter(f => f.endsWith('.json')).sort() : [fresh || hardened || production ? 'candidate.json' : 'devnet.json']
  if (directory === 'idl' && names.length !== 11) throw new Error('Expected all eleven raw IDLs.')
  for (const name of names) await copyFile(directory === 'integration' ? manifestPath : path.join(source, 'sdk/packages/sdk', directory, name), path.join(output, directory, name))
}
for (const name of ['LICENSE', 'NOTICE', 'FORK.md']) await copyFile(path.join(source, name), path.join(output, name))

// Full licenses/notices for every bundled package, not just retained source comments.
const packages = new Map()
for (const input of Object.keys(result.metafile.inputs).sort()) {
  if (!input.includes('node_modules/')) continue
  let directory = path.dirname(path.resolve(source, input))
  while (directory !== source && directory !== path.dirname(directory)) {
    try {
      const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
      if (pkg.name && pkg.version) { packages.set(`${pkg.name}@${pkg.version}`, { directory, pkg }); break }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    directory = path.dirname(directory)
  }
}
let notices = '# Bundled third-party licenses and notices\n\nGenerated from the pinned Hook Lab SDK lockfile. External @solana/web3.js is installed separately.\n'
const dependencies = []
for (const [id, { directory, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  const files = (await readdir(directory)).filter(f => /^(licen[cs]e|copying|notice|copyright)([.-]|$)/i.test(f)).sort()
  if (id === 'pako@2.2.0') files.push('lib/zlib/README') // The root license covers MIT only, not its bundled zlib port.
  // These npm tarballs omit LICENSE. Their npm gitHead values identify this exact source.
  const anchorSource = ['@anchor-lang/core@1.2.1', '@anchor-lang/borsh@1.2.1', '@anchor-lang/errors@1.2.1'].includes(id)
    ? 'https://github.com/otter-sec/anchor/blob/f1d20a94e8857d66e39810039aa5b5eee9ff733e/LICENSE' : null
  if (!files.length && anchorSource) files.push('anchor-1.2.1.LICENSE')
  if (id === 'bs58@4.0.1' && !files.length) files.push('bs58-4.0.1.LICENSE', 'README.md')
  if (!files.length) throw new Error(`Missing complete license text for ${id}; inspect before redistributing.`)
  notices += `\n## ${id}\n\nDeclared license: ${pkg.license}\n`
  if (anchorSource) notices += `\nLicense source: ${anchorSource}\n`
  if (id === 'bs58@4.0.1') notices += '\n4.0.1 declares MIT but omits its text. Full notice subsequently added by the project at https://github.com/cryptocoinjs/bs58/blob/ec21ace130d0c08cc317448952b679ec1b93f17d/LICENSE; original README credits retained below.\n'
  const licenses = {}
  for (const file of files) {
    const supplemental = { 'anchor-1.2.1.LICENSE': '66a06877935811daba7b7c33c4eedf0e6017616a4cc1bb5faa4dae72c13f638e',
      'bs58-4.0.1.LICENSE': '57efbd615689807b8341d557af0038fae58da7e2831f29f52d02902f657deb25' }
    const bytes = await readFile(path.join(Object.hasOwn(supplemental, file) ? path.join(root, 'scripts/licenses') : directory, file))
    if (Object.hasOwn(supplemental, file) && sha(bytes) !== supplemental[file]) throw new Error('Supplemental license checksum mismatch.')
    notices += `\n### ${file}\n\n${bytes.toString('utf8')}\n`
    licenses[file] = sha(bytes)
  }
  dependencies.push({ package: id, license: pkg.license, licenses })
}
await writeFile(path.join(output, 'THIRD_PARTY_NOTICES.md'), notices.trimEnd() + '\n')
const files = {}
for (const directory of ['', 'dist', ...idlDirectories, 'integration']) {
  for (const entry of (await readdir(path.join(output, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!entry.isFile() || ['provenance.json', 'package.json'].includes(entry.name)) continue
    const name = path.posix.join(directory, entry.name)
    files[name] = sha(await readFile(path.join(output, name)))
  }
}
await writeFile(path.join(output, 'provenance.json'), JSON.stringify({
  repository: 'https://github.com/New1Direction/hook-lab', revision,
  abiSourceCommit: fresh || hardened || production ? revision : JSON.parse(manifest).sourceCommit, manifestSha256: manifestHash,
  sdkLockSha256: sha(await readFile(path.join(source, 'sdk/pnpm-lock.yaml'))),
  esbuild: version, target: 'node22', externalWeb3: '1.98.4', dependencies, files,
}, null, 2) + '\n')
console.log(`Vendored ${production ? 'disabled production candidate' : hardened ? 'inert hardened candidate' : fresh ? 'isolated guarded candidate' : 'six read-only exports'} from ${revision}; ${dependencies.length} bundled dependency notices.`)
