import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const destination = process.argv[2]
if (process.argv.length !== 3 || !destination) throw Error('Build destination required')
const root = resolve(destination)
mkdirSync(join(root, 'scripts/shadow'), { recursive: true })
mkdirSync(join(root, 'config'), { recursive: true })
const output = join(root, 'scripts/shadow/runner.mjs')
const result = await build({ entryPoints: ['scripts/shadow/runner.mjs'], outfile: output,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['pg-native'], metafile: true, logLevel: 'silent',
  banner: { js: "import { createRequire as __nodeRequire } from 'node:module'; import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __dirnameOf } from 'node:path'; const require = __nodeRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);" } })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = Object.keys(result.metafile.inputs).sort()
if (inputs.some(p => /\.(so|elf|env|pem|key|age)$/.test(p) || p.includes('hook-lab'))) throw Error('Forbidden build input')
const tracked = new Set(execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n'))
if (inputs.some(p => !p.startsWith('node_modules/') && !p.startsWith('scripts/shadow/') && !tracked.has(p))) throw Error('Unreviewed build input')
const manifest = 'config/existing-market-custody.json'
copyFileSync(manifest, join(root, manifest))
const sources = Object.fromEntries([...inputs, manifest, 'package-lock.json', 'scripts/shadow/build.mjs'].sort().map(p => [p, hash(readFileSync(p))]))
const metadata = { baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDigest: hash(JSON.stringify(sources)), runnerSha256: hash(readFileSync(output)), custodySha256: hash(readFileSync(manifest)),
  sources, productionEntrypoints: false, privateElfInputs: false }
writeFileSync(join(root, 'build.json'), JSON.stringify(metadata, null, 2) + '\n')
console.log(JSON.stringify({ baseCommit: metadata.baseCommit, sourceDigest: metadata.sourceDigest, runnerSha256: metadata.runnerSha256,
  inputs: inputs.length, privateElfInputs: false }))
