// Accounting-only counterpart of the reviewed step-7 build; never rebuilds chart.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

assert.equal(process.argv.length, 3, 'Build destination required')
const destination = path.resolve(process.argv[2])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifestPath = 'config/existing-market-custody.json'
const manifest = fs.readFileSync(manifestPath)
const expected = '2c31354ba8009acb0da1319b068f479216b0615120328510cba50665f0ecd888'
assert.equal(hash(manifest), expected)
fs.mkdirSync(path.join(destination, 'scripts'), { recursive: true })
fs.mkdirSync(path.join(destination, 'config'), { recursive: true })
fs.writeFileSync(path.join(destination, manifestPath), manifest)

// Preserve the installed accounting entrypoint and bounded output contract.
const contents = `import {runRecoveryFees} from './scripts/recovery-fee-indexer.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const lane="accounting";
console.log=()=>{}; console.error=()=>{}; console.warn=()=>{};
const report=o=>process.stdout.write(JSON.stringify(o)+'\\n');
if(process.argv[2]==='--validate') {
  const bytes=readFileSync(new URL('../config/existing-market-custody.json',import.meta.url));
  if(createHash('sha256').update(bytes).digest('hex')!==${JSON.stringify(expected)})process.exit(1);
  report({lane,status:'VALIDATED_NO_EXECUTION',networkCalls:0,databaseWrites:0});
} else {
  try {
    const env={...process.env};
    if(lane==='chart')env.SOLANA_VERIFICATION_RPC_URL=env.CHART_SOLANA_VERIFICATION_RPC_URL;
    const result=await runRecoveryFees(env);
    const rows=Array.isArray(result)?result:result.results;
    if(!Array.isArray(rows)||rows.length===0||rows.some(r=>r.status==='ERROR'||r.error||r.status==='BUSY'))throw Error('INCOMPLETE_CYCLE');
    report({lane,status:'CYCLE_COMPLETED',at:new Date().toISOString(),markets:rows.length});
  } catch {
    report({lane,status:'CYCLE_FAILED'});process.exitCode=1;
  }
}`
const output = path.join(destination, 'scripts/accounting.mjs')
const result = await build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: 'accounting-runner.mjs', loader: 'js' },
  outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import {createRequire as __nodeRequire} from 'node:module'; const require=__nodeRequire(import.meta.url); import {fileURLToPath as __fileURLToPath} from 'node:url'; const __filename=__fileURLToPath(import.meta.url);" },
  external: ['pg-native'], metafile: true, logLevel: 'silent', plugins: [{ name: 'remove-direct-cli-only', setup(b) {
    b.onLoad({ filter: /recovery-(fee|chart)-indexer\.mjs$/ }, args => {
      const source = fs.readFileSync(args.path, 'utf8')
      const marker = '\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {'
      assert.equal(source.split(marker).length, 2)
      return { contents: source.split(marker)[0], loader: 'js', resolveDir: path.dirname(args.path) }
    })
  } }] })
const inputs = Object.keys(result.metafile.inputs).filter(p => p !== 'accounting-runner.mjs').sort()
assert(!inputs.some(p => /\.(so|elf|env|pem|key|age)$/.test(p) || p.includes('hook-lab')))
const sources = Object.fromEntries([...inputs, manifestPath, 'package-lock.json', 'scripts/build-recovery-accounting.mjs']
  .sort().map(p => [p, hash(fs.readFileSync(p))]))
const metadata = { baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDigest: hash(JSON.stringify(sources)), runnerSha256: hash(fs.readFileSync(output)), custodySha256: expected,
  sources, privateElfInputs: false, secretInputs: false, lanes: ['accounting'] }
fs.writeFileSync(path.join(destination, 'build.json'), JSON.stringify(metadata, null, 2) + '\n')
console.log(JSON.stringify({ sourceDigest: metadata.sourceDigest, runnerSha256: metadata.runnerSha256,
  inputs: inputs.length, lanes: metadata.lanes }))
