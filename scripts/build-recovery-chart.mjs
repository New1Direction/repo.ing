import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
assert.equal(process.argv.length, 3, 'Build destination required')
const dir = path.resolve(process.argv[2])
fs.mkdirSync(dir + '/scripts', { recursive: true }); fs.mkdirSync(dir + '/config', { recursive: true })
const manifest = fs.readFileSync('config/existing-market-custody.json')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
fs.writeFileSync(dir + '/config/existing-market-custody.json', manifest)
const contents = `import { runRecoveryCharts, runChartsWithRetries, createChartDiagnostics, chartFailure, chartReason, CHART_RETRY_EXIT } from './scripts/recovery-chart-indexer.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const report = o => process.stdout.write(JSON.stringify(o)+'\\n');
let diagnostics = createChartDiagnostics();
const failure = (error, phase = 'PREFLIGHT') => {
  const fallback = createChartDiagnostics(), scope = fallback.scope();
  scope.phase(phase); scope.fail(error);
  const retained = diagnostics.reports();
  return phase === 'FATAL' ? [...retained, ...fallback.reports()] : retained.length ? retained : fallback.reports();
};
// Preserve fatal exit1, but never let Node print raw DB errors or stack traces.
process.setUncaughtExceptionCaptureCallback(error => {
  report({lane:'chart',status:'CYCLE_FAILED',diagnostics:failure(error,'FATAL')});process.exit(1);
});
if(process.argv.length === 3 && process.argv[2] === '--validate') {
  if(createHash('sha256').update(readFileSync(new URL('../config/existing-market-custody.json',import.meta.url))).digest('hex')!==${JSON.stringify(hash(manifest))})process.exit(1);
  report({lane:'chart',status:'VALIDATED_NO_EXECUTION',networkCalls:0,databaseWrites:0});
} else if(process.argv.length !== 2) {
  report({lane:'chart',status:'ARGUMENTS_DENIED'});process.exitCode=1;
} else {
  const deadline = setTimeout(()=>{report({lane:'chart',status:'DEADLINE'});process.exit(1)},900000);
  let phase = 'PREFLIGHT';
  try {
    if(process.env.RECOVERY_CHART_RPC_MODE !== 'archival-paced')throw Error('MODE_REQUIRED');
    const names=['RECOVERY_CHART_DATABASE_URL','SOLANA_RPC_URL','SOLANA_ARCHIVE_VERIFICATION_RPC_URL','DBC_CONFIG','DBC_LEGACY_CONFIGS','TRADING_CUSTODY_RECOVERY_SHA256','RECOVERY_CHART_RPC_MODE'];
    const env=Object.fromEntries(names.map(k=>[k,process.env[k]]));
    // A one-off read failure reruns the whole pass (fresh diagnostics) up to three times; a data problem never does.
    const result=await runChartsWithRetries(async attempt=>{
      if(attempt>0){diagnostics=createChartDiagnostics();phase='PREFLIGHT';}
      const pass=await runRecoveryCharts(env,diagnostics);
      phase = 'COMPLETENESS';
      if(!Array.isArray(pass.results)||pass.results.length===0||pass.results.some(r=>r.error))throw Error('INCOMPLETE_CYCLE');
      return pass;
    },{onRetry:({attempt,waitMs,error})=>report({lane:'chart',status:'CYCLE_RETRY',attempt,waitMs,code:chartFailure(error).code,reason:chartReason(error),diagnostics:failure(error,phase)})});
    report({lane:'chart',status:'CYCLE_COMPLETED',at:result.at,markets:result.results.length,transactions:result.results.reduce((n,r)=>n+r.transactions,0),inserted:result.results.reduce((n,r)=>n+r.inserted,0)});
  } catch(error) {
    const {code,retryable}=chartFailure(error);
    report({lane:'chart',status:'CYCLE_FAILED',code,retryable,reason:chartReason(error),diagnostics:failure(error,phase)});
    process.exitCode=retryable?CHART_RETRY_EXIT:1;
  }
  finally {clearTimeout(deadline)}
}`
const result = await build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: 'chart-runner.mjs', loader: 'js' },
  outfile: dir + '/scripts/chart.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['pg-native'],
  banner: { js: "import { createRequire as __nodeRequire } from 'node:module'; import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __dirnameOf } from 'node:path'; const require = __nodeRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename); console.log=console.error=console.warn=console.info=console.debug=()=>{};" },
  metafile: true, logLevel: 'silent', plugins: [{ name: 'remove-direct-cli-only', setup(b) {
    b.onLoad({ filter: /recovery-chart-indexer\.mjs$/ }, args => {
      const source = fs.readFileSync(args.path, 'utf8')
      const marker = '\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {'
      assert.equal(source.split(marker).length, 2)
      return { contents: source.split(marker)[0], loader: 'js', resolveDir: path.dirname(args.path) }
    })
  } }] })
const inputs = Object.keys(result.metafile.inputs).sort()
assert(!inputs.some(p => /\.(so|elf|env|pem|key|age)$/.test(p) || p.includes('hook-lab')))
const metadata = { sourceSha256: hash(fs.readFileSync('scripts/recovery-chart-indexer.mjs')),
  runnerSha256: hash(fs.readFileSync(dir + '/scripts/chart.mjs')), wrapperSha256: hash(contents),
  inputs: Object.fromEntries(inputs.filter(p => p !== 'chart-runner.mjs').map(p => [p,hash(fs.readFileSync(p))])),
  privateElfInputs: false, accountingBuilt: false }
metadata.sourceDigest = hash(JSON.stringify({ ...metadata.inputs, manifest: hash(manifest),
  build: hash(fs.readFileSync('scripts/build-recovery-chart.mjs')), lockfile: hash(fs.readFileSync('package-lock.json')) }))
fs.writeFileSync(dir+'/build.json', JSON.stringify(metadata,null,2)+'\n')
console.log(JSON.stringify({source:metadata.sourceSha256,writer:metadata.runnerSha256,inputs:inputs.length}))
