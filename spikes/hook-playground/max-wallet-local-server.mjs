/** Separate opt-in loopback server. The original networkless Playground server is unchanged. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { LocalError, MaxWalletLocalSession, createVmTransport } from './max-wallet-local-session.mjs';

const MAX_REQUEST = 8192, MAX_RESPONSE = 65536;
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/model.mjs': ['model.mjs', 'text/javascript; charset=utf-8'],
  '/draft.mjs': ['draft.mjs', 'text/javascript; charset=utf-8'],
  '/plain-draft.mjs': ['plain-draft.mjs', 'text/javascript; charset=utf-8'],
  '/assets/brand-cat.webp': ['assets/brand-cat.webp', 'image/webp'],
  '/max-wallet-flow.mjs': ['max-wallet-flow.mjs', 'text/javascript; charset=utf-8'],
  '/max-wallet-flow-state.mjs': ['max-wallet-flow-state.mjs', 'text/javascript; charset=utf-8'],
  '/max-wallet-flow.css': ['max-wallet-flow.css', 'text/css; charset=utf-8'],
};
const headers = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin', 'X-Amp-Review-Widget': 'off',
};
function sameToken(value, token) {
  return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
}
async function body(req) {
  if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'] !== undefined) throw new LocalError('INVALID_INPUT', 'Use uncompressed application/json.');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST)) throw new LocalError('INVALID_INPUT', 'Request body exceeds its bound.', 413);
  let count = 0; const chunks = [];
  for await (const chunk of req) { count += chunk.length; if (count > MAX_REQUEST) throw new LocalError('INVALID_INPUT', 'Request body exceeds its bound.', 413); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new LocalError('INVALID_INPUT', 'Request body must be valid UTF-8 JSON.'); }
}
function errorBody(error, value) {
  const knownRefusal = error instanceof LocalError && [409, 422].includes(error.status);
  return { schema: knownRefusal ? 'repoing/max-wallet-local-error/1' : 'repoing/max-wallet-local-unavailable/1', requestId: typeof value?.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(value.requestId) ? value.requestId : null,
    action: ['prepare', 'launch', 'buy', 'sell', 'quote', 'pause'].includes(value?.action) ? value.action : null,
    code: knownRefusal ? error.code : 'UNAVAILABLE', error: knownRefusal ? error.message : 'The local outcome is unavailable. Further execution must stay locked. No internal details are exposed.',
    ...(knownRefusal ? { executionAttempted: false } : { outcome: 'unresolved' }), canSign: false, canSubmit: false };
}
export function defaultDriverConfiguration() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const recovered = resolve(root, 'recovered-amp');
  const fixedFiles = {
    driver: resolve(recovered, 'host-target/debug/deps/maxwallet_browser-2a299d230415f1df'), profile: resolve(recovered, 'audit/maxwallet-offline-builder-profile.json'),
    vector: resolve(recovered, 'audit/maxwallet-builder-vector.json'), retainedAccounts: resolve(root, '../hook-cost-audit/same-id-feasibility/old-state-fixture/accounts.json'),
    rentPacket: resolve(recovered, 'hook-custom-paused-a33957a/proposal.json'), driverSourcePatch: resolve(recovered, 'audit/maxwallet-browser-driver.patch'),
    launchElf: resolve(recovered, 'rebuilt-maxwallet/bordrless_launch.so'), swapElf: resolve(recovered, 'rebuilt-maxwallet/bordrless_swap.so'),
    gateElf: resolve(recovered, 'rebuilt-maxwallet/hook_max_wallet.so'), tokenElf: resolve(recovered, 'rebuilt-maxwallet/bordrless_token.so'),
  };
  return { command: resolve(recovered, 'host-target/debug/deps/maxwallet_browser-2a299d230415f1df'),
    expectedManifest: { path: resolve(recovered, 'audit/maxwallet-browser-driver-manifest.json'), sha256: 'b04caafe9694b624d7ab2ef83fd4870ab091a0f326d95372763e7324c9b24a0e', fixedFiles },
    expectedExecutable: { bytes: 132216280, sha256: '3c9185bb6192719460ca5f54230866ba0f4fb206ca7ce1abe12898184702f547' },
    args: ['--exact', 'canary::browser_vm_driver', '--ignored', '--nocapture', '--test-threads=1'], cwd: recovered,
    env: { OLD_STATE_FIXTURE: resolve(root, '../hook-cost-audit/same-id-feasibility/old-state-fixture'),
      CUSTOM_PAUSED_PACKET: resolve(recovered, 'hook-custom-paused-a33957a'), SBF_OUT_DIR: resolve(recovered, 'rebuilt-maxwallet'),
      MAXWALLET_PROFILE: resolve(recovered, 'audit/maxwallet-offline-builder-profile.json'), MAXWALLET_REPLAY_VECTOR: resolve(recovered, 'audit/maxwallet-builder-vector.json') } };
}
/** Starts only on literal IPv4 loopback, never a wildcard host or externally supplied URL. */
export async function startMaxWalletLocalServer({ localTest = false, port = 4175, session = null } = {}) {
  if (localTest !== true) throw Error('Explicit localTest mode is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Port is invalid');
  let ownedSession = session;
  try {
    ownedSession ??= new MaxWalletLocalSession({ transport: await createVmTransport(defaultDriverConfiguration()) });
    await ownedSession.initialize();
  } catch { await ownedSession?.close(); throw Error('Local SBF driver could not initialize; verify the retained public fixture, manifest and local binary.'); }
  const token = randomBytes(32).toString('base64url');
  let assets;
  try {
    assets = new Map(await Promise.all(Object.entries(files).map(async ([path, [file, type]]) => {
      let bytes = await readFile(new URL(file, import.meta.url));
      if (path === '/') bytes = Buffer.from(bytes.toString('utf8').replace('</head>', `<meta name="hooklab-local-session" content="${token}"><link rel="stylesheet" href="/max-wallet-flow.css"></head>`)
        .replace('</header>', '<button id="max-wallet-local-open" class="quiet" aria-expanded="false" aria-controls="max-wallet-local-workspace">Local max-wallet test</button></header>')
        .replace('</body>', '<script type="module" src="/max-wallet-flow.mjs"></script></body>'));
      return [path, { bytes, type }];
    })));
  } catch { await ownedSession.close(); throw Error('Local UI assets are incomplete.'); }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 1000 }, async (req, res) => {
    let value;
    const send = (status, bytes, type = 'application/json; charset=utf-8', extra = {}) => {
      if (res.destroyed || res.writableEnded) return;
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(typeof bytes === 'string' ? bytes : JSON.stringify(bytes));
      if (type.startsWith('application/json') && body.length > MAX_RESPONSE) { res.writeHead(503, { ...headers, 'Content-Type': 'text/plain', 'Content-Length': '20' }); res.end('Response unavailable'); return; }
      res.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': body.length, ...extra }); res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      const authority = `127.0.0.1:${server.address().port}`, origin = `http://${authority}`;
      const names = req.rawHeaders.filter((_, i) => i % 2 === 0).map(x => x.toLowerCase());
      if (['host', 'origin', 'x-hooklab-local', 'content-type'].some(x => names.filter(n => n === x).length > 1) || req.headers.host !== authority) return send(403, 'Loopback host required', 'text/plain');
      if (req.headers.origin !== undefined && req.headers.origin !== origin || req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return send(403, 'Same origin required', 'text/plain');
      const path = req.url;
      if (path === '/healthz' && ['GET', 'HEAD'].includes(req.method)) return send(200, { status: 'ok', localTestOnly: true, synthetic: true, canSign: false, canSubmit: false });
      if (path === '/__local/max-wallet/state') {
        if (req.method !== 'GET') return send(405, 'Method not allowed', 'text/plain', { Allow: 'GET' });
        if (!sameToken(req.headers['x-hooklab-local'], token)) return send(403, 'Local session token required', 'text/plain');
        const state = await ownedSession.state(); return send(200, state);
      }
      if (path === '/__local/max-wallet/review' || path === '/__local/max-wallet/action') {
        if (req.method !== 'POST') return send(405, 'Method not allowed', 'text/plain', { Allow: 'POST' });
        if (req.headers.origin !== origin || !sameToken(req.headers['x-hooklab-local'], token)) return send(403, 'Same-origin local session required', 'text/plain');
        value = await body(req);
        const result = await ownedSession[path.endsWith('/review') ? 'review' : 'action'](value);
        return send(result.outcome === 'unresolved' ? 503 : 200, result);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'Method not allowed', 'text/plain', { Allow: 'GET, HEAD' });
      const asset = assets.get(path);
      if (!asset) return send(404, 'Not found', 'text/plain');
      return send(200, asset.bytes, asset.type);
    } catch (error) { if (!(error instanceof LocalError)) ownedSession.uncertain = true; return send(error instanceof LocalError ? error.status : 503, errorBody(error, value)); }
  });
  server.maxConnections = 12;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch { await ownedSession.close(); throw Error('Loopback port is unavailable.'); }
  let closed = false;
  return { url: `http://127.0.0.1:${server.address().port}`, server,
    async close() { if (closed) return; closed = true; const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await ownedSession.close(); await stopped; } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] !== '--local-test' || args.length !== 1 && !(args.length === 3 && args[1] === '--port' && /^\d+$/.test(args[2]))) {
    console.error('Usage: node max-wallet-local-server.mjs --local-test [--port 4175]'); process.exitCode = 1;
  } else {
    let running = null, stopRequested = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { stopRequested = true; await running?.close(); process.exitCode = 0; });
    try {
      running = await startMaxWalletLocalServer({ localTest: true, port: args[2] === undefined ? 4175 : Number(args[2]) });
      if (stopRequested) await running.close();
      else {
        console.log(`Local synthetic SBF Playground: ${running.url}`);
        console.log('No real wallet, signatures, RPC, broadcast, production receipt or public activation. Stop and restart to discard this session.');
      }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
