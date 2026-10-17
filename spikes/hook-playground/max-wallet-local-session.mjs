/** Explicit local-test-only causal SBF session. No wallet, RPC, production receipt or signing. */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { BorshCoder } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { planMaxWalletPreparation, deriveMaxWalletPreparedAccounts } from '../../src/hooklab-max-wallet-preparation.mjs';
import { buildMaxWalletLaunchReviewForFixture } from '../../src/hooklab-max-wallet-launch.mjs';
import { buildMaxWalletSwapReviewForFixture, maxWalletSwapInventory } from '../../src/hooklab-max-wallet-swap.mjs';
import { maxWalletPreparationFixture, maxWalletPreparationRequest, maxWalletProfileEnvelope, maxWalletFrozenPins, pda, pk } from '../../tests/fixtures/hooklab-max-wallet-preparation.mjs';
import { maxWalletLaunchFixture } from '../../tests/fixtures/hooklab-max-wallet-launch.mjs';

const HASH = /^[a-f0-9]{64}$/;
const U64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(x => BigInt(x) <= 18446744073709551615n);
const positive = U64.refine(x => BigInt(x) > 0n);
const key = z.string().refine(x => { try { return new PublicKey(x).toBase58() === x; } catch { return false; } });
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = (max, empty = false) => z.string().refine(x => (empty || x.length > 0) && Buffer.byteLength(x) <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(x));
const inputs = {
  prepare: z.object({ capBps: z.number().int().min(1).max(9999), label: text(32) }).strict(),
  launch: z.object({ name: text(32), symbol: text(10), uri: text(200, true), virtualQuote: positive }).strict(),
  pause: z.object({ paused: z.boolean() }).strict(),
  quote: z.object({ direction: z.enum(['buy', 'sell']), amountInRaw: positive, minAmountOutRaw: z.literal('0') }).strict(),
  buy: z.object({ direction: z.literal('buy'), amountInRaw: positive, minAmountOutRaw: positive }).strict(),
  sell: z.object({ direction: z.literal('sell'), amountInRaw: positive, minAmountOutRaw: positive }).strict(),
};
const envelope = z.object({ schema: z.literal('repoing/max-wallet-local-action/1'), requestId: z.string().uuid(),
  expectedRevision: integer, action: z.enum(['prepare', 'launch', 'buy', 'sell', 'quote', 'pause']), input: z.unknown(), reviewId: z.string().uuid().optional() }).strict();
export const sha = x => createHash('sha256').update(x).digest('hex');
export function canonicalJson(x) {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(',')}]`;
  if (x !== null && typeof x === 'object') return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}
export class LocalError extends Error {
  constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new LocalError(code, message, status); };
export function parseLocalAction(value, kind) {
  const parsed = envelope.safeParse(value);
  if (!parsed.success) fail('INVALID_INPUT', 'Action envelope is invalid. All required fields must be explicit.');
  const v = parsed.data, input = inputs[v.action].safeParse(v.input);
  if (!input.success) fail('INVALID_INPUT', 'Action inputs are invalid. Use explicit whole raw-unit amounts and bounded text.');
  const reviewed = ['prepare', 'launch', 'buy', 'sell'].includes(v.action);
  if (kind === 'review' && (!reviewed || v.reviewId !== undefined) || kind === 'action' && (reviewed !== (v.reviewId !== undefined))) fail('INVALID_INPUT', 'This action requires its exact review identifier.');
  return { ...v, input: input.data };
}
const vmAccount = z.object({ pubkey: key, account: z.object({ owner: key, executable: z.boolean(), lamports: U64,
  dataBase64: z.string().max(9000000), dataSha256: z.string().regex(HASH) }).strict().nullable() }).strict();
const vmQuote = z.object({ direction: z.union([z.literal(0), z.literal(1)]), amountIn: positive, delivered: U64,
  minAmountOut: positive, slippageBps: integer.max(9999), lpFee: U64, protocolFee: U64, cap: U64, wouldExceedCap: z.boolean(),
  baseReserve: U64, quoteReserve: U64, virtualBase: U64, virtualQuote: U64,
  instruction: z.object({ programId: key, keys: z.array(z.object({ pubkey: key, isSigner: z.boolean(), isWritable: z.boolean() }).strict()).max(64), dataHex: z.string().regex(/^(?:[a-f0-9]{2})+$/).max(4096) }).strict(),
  onchainGuard: z.literal('exact-input-and-minimum-delivered-output-only'), onchainDeadlineGuard: z.literal(false), onchainEconomicsHashGuard: z.literal(false),
}).strict();
const vmSchema = z.object({ schema: z.literal('hooklab/max-wallet-vm-response/1'), id: z.string().max(128), action: z.string(),
  sessionId: key, revision: integer, historyDigest: z.string().regex(HASH), requestDigest: z.string().regex(HASH),
  status: z.enum(['succeeded', 'program-failed', 'rejected']), phase: z.enum(['unprepared', 'prepared', 'launched']),
  slot: U64, blockHeight: U64, blockhash: key, blockhashValidation: z.literal(false), paused: z.boolean(),
  rentExemptionLamports: z.object({ policy: positive, registry: positive, selectedConfig: positive }).strict(),
  messageSha256: z.string().regex(HASH).nullable(), error: z.string().max(16384).nullable(), logs: z.array(z.string().max(16384)).max(1024),
  accounts: z.array(vmAccount).min(12).max(128), balances: z.object({ base: U64, quote: U64, payerLamports: U64 }).strict(), quote: vmQuote.nullable(), unixTimestamp: z.string().regex(/^(0|-?[1-9][0-9]{0,18})$/), auxiliaryFixtureActions: z.array(z.enum(['actual-token-create-empty-canonical-base-holding', 'actual-local-governance-pause-change'])).max(2),
  synthetic: z.literal(true), signaturesVerified: z.literal(false), artifactAdopted: z.literal(false), canSign: z.literal(false), canSubmit: z.literal(false), publicExecutionEnabled: z.literal(false),
}).strict();
export function validateVmResponse(value, request, prior = null) {
  const v = vmSchema.parse(value);
  if (v.id !== request.id || v.action !== request.action || v.requestDigest !== sha(canonicalJson(request))) throw Error('VM response binding differs');
  if (Number(v.slot) > Number.MAX_SAFE_INTEGER || Number(v.blockHeight) > Number.MAX_SAFE_INTEGER) throw Error('VM height is unsafe');
  if (new Set(v.accounts.map(x => x.pubkey)).size !== v.accounts.length) throw Error('VM inventory duplicates');
  for (const { account } of v.accounts) if (account) {
    const bytes = Buffer.from(account.dataBase64, 'base64');
    if (bytes.toString('base64') !== account.dataBase64 || sha(bytes) !== account.dataSha256) throw Error('VM account bytes differ');
  }
  if (['state', 'quote', 'pause'].includes(request.action) && v.messageSha256 !== null) throw Error('Non-message operation returned a message hash');
  if (request.action !== 'quote' && v.quote !== null) throw Error('Unexpected quote');
  if (v.status !== 'rejected' && request.action === 'quote' && v.quote === null) throw Error('Missing quote');
  validateVmBalances(v);
  if (prior) {
    if (v.sessionId !== prior.sessionId || v.revision < prior.revision) throw Error('VM session or revision differs');
    if (request.action !== 'state') {
      const attempted = ['prepare', 'launch', 'buy', 'sell', 'pause'].includes(request.action) && v.status !== 'rejected';
      if (v.revision !== prior.revision + Number(attempted)) throw Error('VM revision is not causal');
      if (attempted === (v.historyDigest === prior.historyDigest)) throw Error('VM history is not causal');
      if (attempted && request.action !== 'pause' && v.messageSha256 !== request.plan.review.messageSha256) throw Error('VM message differs');
      if (v.status === 'succeeded') {
        const phase = request.action === 'prepare' ? 'prepared' : request.action === 'launch' ? 'launched' : prior.phase;
        if (v.phase !== phase || (request.action === 'pause' ? v.paused !== request.paused : v.paused !== prior.paused)) throw Error('VM action phase differs');
      }
      if (!attempted && canonicalJson(v.accounts) !== canonicalJson(prior.accounts)) throw Error('Read or rejection changed accounts');
      if (v.status === 'program-failed' && (v.phase !== prior.phase || v.balances.base !== prior.balances.base || v.balances.quote !== prior.balances.quote)) throw Error('Failed program changed token balances');
    }
  }
  return v;
}

async function verifyPinnedFile(path, pin) {
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || !HASH.test(pin.sha256)) throw Error('Local file pin is invalid');
  let size = 0; const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) { size += bytes.length; if (size > pin.bytes) throw Error('Local file size differs from reviewed pin'); digest.update(bytes); }
  if (size !== pin.bytes || digest.digest('hex') !== pin.sha256) throw Error('Local file hash differs from reviewed pin');
}
/** One child, one outstanding request, bounded lines/time/history; no shell or inherited credentials. */
export async function createVmTransport({ command, args = [], env = {}, cwd, expectedExecutable = null, expectedManifest = null, timeoutMs = 20000, maxBytes = 10000000, maxRequests = 120 }) {
  if (typeof command !== 'string' || !command.startsWith('/')) throw Error('An explicit absolute local driver path is required');
  const allowed = ['OLD_STATE_FIXTURE', 'CUSTOM_PAUSED_PACKET', 'SBF_OUT_DIR', 'MAXWALLET_PROFILE', 'MAXWALLET_REPLAY_VECTOR'];
  if (Object.keys(env).some(k => !allowed.includes(k))) throw Error('Only public local fixture environment is permitted');
  if (expectedManifest) {
    const parts = []; let length = 0;
    for await (const part of createReadStream(expectedManifest.path)) { length += part.length; if (length > 16384) throw Error('Local driver manifest exceeds its bound'); parts.push(part); }
    const bytes = Buffer.concat(parts);
    if (sha(bytes) !== expectedManifest.sha256) throw Error('Local driver manifest differs from reviewed pin');
    const manifest = JSON.parse(bytes);
    if (manifest.schema !== 'hook-lab/local-max-wallet-driver-manifest/1' || manifest.synthetic !== true || manifest.artifactAdopted !== false
      || manifest.canSign !== false || manifest.canSubmit !== false || canonicalJson(manifest.command) !== canonicalJson(args)
      || canonicalJson(Object.keys(manifest.files).sort()) !== canonicalJson(Object.keys(expectedManifest.fixedFiles).sort())) throw Error('Local driver manifest contract differs');
    for (const [role, path] of Object.entries(expectedManifest.fixedFiles)) {
      const pin = manifest.files[role];
      if (pin.path !== path) throw Error('Local driver input path differs from fixed configuration');
      // Only the known configuration supplies filesystem paths. Manifest build commands are never run.
      await verifyPinnedFile(path, pin);
    }
  }
  if (expectedExecutable) await verifyPinnedFile(command, expectedExecutable);
  const child = spawn(command, args, { cwd, shell: false, env: { LANG: 'C.UTF-8', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = null, buffer = Buffer.alloc(0), requests = 0, ended = false;
  const lateIds = new Set();
  function rejectPending() { if (pending) { const p = pending; pending = null; clearTimeout(p.timer); lateIds.add(p.id); p.reject(Error('Local VM outcome is unresolved')); } }
  child.on('error', () => { ended = true; rejectPending(); });
  child.on('exit', () => { ended = true; rejectPending(); });
  child.stderr.on('data', () => {}); // Drain without retaining or exposing driver internals.
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxBytes) { ended = true; rejectPending(); child.kill('SIGKILL'); buffer = Buffer.alloc(0); return; }
    for (;;) {
      const end = buffer.indexOf(10); if (end < 0) break;
      const line = buffer.subarray(0, end).toString('utf8'); buffer = buffer.subarray(end + 1);
      if (!line.startsWith('VM_JSON ')) continue;
      let value; try { value = JSON.parse(line.slice(8)); } catch { rejectPending(); continue; }
      if (lateIds.has(value.id)) { lateIds.delete(value.id); continue; }
      if (!pending || value.id !== pending.id) { rejectPending(); continue; }
      const p = pending; pending = null; clearTimeout(p.timer); p.resolve(value);
    }
  });
  return {
    get pid() { return child.pid; },
    request(value) {
      if (ended || pending || requests >= maxRequests) return Promise.reject(Error('Local VM is unavailable; restart explicitly'));
      const source = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(source) > maxBytes) return Promise.reject(Error('Local VM request exceeds bound'));
      requests++;
      return new Promise((resolve, reject) => {
        pending = { id: value.id, resolve, reject, timer: setTimeout(() => rejectPending(), timeoutMs) };
        child.stdin.write(source, error => { if (error) rejectPending(); });
      });
    },
    async close() {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      rejectPending(); ended = true;
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.stdin.end(); child.kill('SIGTERM');
      });
    },
  };
}

const notice = 'Disposable local SBF test with synthetic balances and liquidity. Signature and blockhash validation are disabled. The lookup table and duplicate provider observations are synthetic, not independent RPC evidence. No real wallet onboarding, bridge, signing, broadcast, deployment, or production preparation receipt is proven.';
const profileEnvelope = maxWalletProfileEnvelope();
const profile = JSON.parse(profileEnvelope.json);
const preparationIdentity = maxWalletPreparationRequest();
const launchCoder = new BorshCoder(JSON.parse(Buffer.from(profileEnvelope.idls.launch, 'base64')));
const gateCoder = new BorshCoder(JSON.parse(Buffer.from(profileEnvelope.idls.gate, 'base64')));
const swapCoder = new BorshCoder(JSON.parse(Buffer.from(profileEnvelope.idls.swap, 'base64')));
const addresses = { launchConfig: pda(profile.programs.launch, 'config'), swapConfig: pda(profile.programs.swap, 'config'),
  launchGovernance: pda(profile.programs.launch, 'governance'), swapGovernance: pda(profile.programs.swap, 'governance'),
  authorization: pda(profile.programs.launch, 'creator-authorization', pk(preparationIdentity.creator).toBuffer()), quoteMint: profile.quoteMint,
  policy: pda(profile.programs.gate, 'policy', pk(preparationIdentity.mint).toBuffer()), registry: pda(profile.programs.gate, 'bordrless-hook-accounts', pk(preparationIdentity.mint).toBuffer()) };
export function vmAccounts(state) {
  return new Map(state.accounts.map(({ pubkey: address, account }) => [address, account && { address, owner: account.owner, executable: account.executable, lamports: account.lamports, dataBase64: account.dataBase64 }]));
}
function account(map, address) { if (!map.has(address)) throw Error('VM snapshot omitted required account'); return map.get(address); }
function data(map, address) { const a = account(map, address); if (!a) throw Error('Required VM account is absent'); return Buffer.from(a.dataBase64, 'base64'); }
function validateVmBalances(state) {
  const map = vmAccounts(state), token = profile.programs.token, trader = preparationIdentity.creator;
  for (const [name, mint] of [['base', preparationIdentity.mint], ['quote', profile.quoteMint]]) {
    const address = pda(token, 'holding', pk(mint).toBuffer(), pk(trader).toBuffer()), a = account(map, address);
    if (a === null) { if (name !== 'base' || state.phase === 'launched' || state.balances[name] !== '0') throw Error('VM holding is unexpectedly absent'); continue; }
    const bytes = Buffer.from(a.dataBase64, 'base64');
    if (a.owner !== token || a.executable || bytes.length !== 204 || !bytes.subarray(0, 8).equals(Buffer.from(sha('account:Holding'), 'hex').subarray(0, 8))
      || bytes[8] !== 1 || !bytes.subarray(10, 42).equals(pk(mint).toBuffer()) || !bytes.subarray(42, 74).equals(pk(trader).toBuffer())
      || bytes.readBigUInt64LE(74).toString() !== state.balances[name]) throw Error('VM holding balance differs from actual bytes');
  }
  if (account(map, preparationIdentity.feePayer)?.lamports !== state.balances.payerLamports) throw Error('VM payer balance differs from actual bytes');
}
function rebind(template, state, now, ttl) {
  const map = vmAccounts(state), slot = Number(state.slot), height = Number(state.blockHeight);
  for (const o of template.observations) { o.slot = slot; o.observedAtMs = now; o.accounts = o.accounts.map(({ address }) => ({ address, account: account(map, address) })); }
  Object.assign(template.recentBlockhash, { blockhash: state.blockhash, observedAtMs: now, currentBlockHeight: height, lastValidBlockHeight: height + 150, observedSlot: slot });
  Object.assign(template.limits, { nowMs: now, maxAgeMs: ttl, validUntilSlot: slot + 50, reviewExpiresAtMs: now + ttl });
  return template;
}
export function buildLocalPlan(action, input, state, prepRequest, now = Date.now(), ttl = 30000) {
  if (action === 'prepare') {
    const template = rebind(maxWalletPreparationFixture(), state, now, ttl);
    template.request = { ...preparationIdentity, ...input };
    const rent = Object.values(state.rentExemptionLamports).reduce((n, x) => n + BigInt(x), 0n);
    template.observations.forEach(o => { o.rentExemptionLamports = { ...state.rentExemptionLamports }; });
    template.limits.maxRentLamports = String(rent); template.limits.maxTotalDebitLamports = String(rent + BigInt(template.recentBlockhash.networkFeeLamports));
    return planMaxWalletPreparation(template);
  }
  if (!prepRequest) throw Error('Actual preparation intent is unavailable');
  if (action === 'launch') {
    const template = rebind(maxWalletLaunchFixture(), state, now, ttl), map = vmAccounts(state);
    const c = launchCoder.accounts.decode('Config', data(map, addresses.launchConfig));
    const d = swapCoder.accounts.decode('Config', data(map, addresses.swapConfig));
    template.request = { ...prepRequest, schema: 'repoing/max-wallet-launch-request/1', reviewer: c.admin.toBase58(), ...input };
    const selected = launchCoder.accounts.decode('LaunchConfig', data(map, prepRequest.selectedConfig));
    const expected = deriveMaxWalletPreparedAccounts({ profile: { json: profileEnvelope.json, expectedSha256: profileEnvelope.expectedSha256,
      idls: { launch: profileEnvelope.idls.launch, gate: profileEnvelope.idls.gate } }, request: prepRequest,
      launchConfig: account(map, addresses.launchConfig), observedCreatedAtUnixSeconds: selected.created_at.toString(10) });
    for (const value of Object.values(expected.accounts)) if (!data(map, value.address).equals(Buffer.from(value.dataBase64, 'base64'))) throw Error('Actual prepared account differs from reviewed intent');
    Object.assign(template.preparationEvidence, { preparationIntentSha256: sha(JSON.stringify(prepRequest)), executionSlot: Number(state.slot),
      preparedAccountHashes: Object.fromEntries(Object.entries(expected.accounts).map(([name, value]) => [name, sha(data(map, value.address))])) });
    template.reviewedStateHashes = Object.fromEntries(Object.keys(template.reviewedStateHashes).map(name => [name, sha(data(map, addresses[name]))]));
    template.limits.maxLaunchFeeLamports = c.launch_fee_lamports.toString(10);
    template.limits.maxPoolCreationFeeLamports = d.pool_creation_fee_lamports.toString(10);
    return buildMaxWalletLaunchReviewForFixture(template);
  }
  if (action === 'buy' || action === 'sell') {
    const request = { schema: 'repoing/max-wallet-swap-request/1', policyKind: 'max-wallet', policyVersion: 1, capBps: prepRequest.capBps,
      side: action, trader: prepRequest.creator, recipient: prepRequest.creator, feePayer: prepRequest.feePayer, mint: prepRequest.mint, selectedConfig: prepRequest.selectedConfig,
      amountIn: input.amountInRaw, minAmountOut: input.minAmountOutRaw, maxInput: input.amountInRaw, maxPriceImpactBps: 1000 };
    const map = vmAccounts(state), slot = Number(state.slot), height = Number(state.blockHeight);
    const accounts = maxWalletSwapInventory(profile, request).map(address => ({ address, account: account(map, address) }));
    const fee = request.trader === request.feePayer ? '5000' : '10000';
    return buildMaxWalletSwapReviewForFixture({ profile: maxWalletProfileEnvelope(), request, provenance: 'disposable-litesvm-synthetic-fixture-not-rpc-evidence',
      observations: profileEnvelope.providers.map(provider => ({ provider, genesisHash: profile.genesisHash, commitment: 'finalized', slot, observedAtMs: now, accounts })),
      recentBlockhash: { blockhash: state.blockhash, genesisHash: profile.genesisHash, providers: profileEnvelope.providers, observedAtMs: now, currentBlockHeight: height,
        blockhashValid: true, lastValidBlockHeight: height + 150, observedSlot: slot, networkFeeLamports: fee, lamportsPerSignature: '5000' }, lookupTable: null,
      limits: { nowMs: now, maxAgeMs: ttl, maxSlotLag: 5, validUntilSlot: slot + 50, reviewExpiresAtMs: now + ttl, maxNetworkFeeLamports: fee,
        maxTotalDebitLamports: fee, computeUnitLimit: 600000, computeUnitPriceMicroLamports: '0' } });
  }
  throw Error('Unsupported unsigned plan');
}
function reviewError(error) {
  const text = String(error?.message ?? '');
  if (/cap would be exceeded/.test(text)) return 'Max-wallet cap would be exceeded. No execution was attempted.';
  if (/Minimum output/.test(text)) return 'The requested minimum output or available liquidity is not met. No execution was attempted.';
  if (/pause/.test(text)) return 'The local program is paused. No execution was attempted.';
  if (/Input exceeds/.test(text)) return 'The input exceeds the explicit limit or synthetic holding balance. No execution was attempted.';
  if (/Price impact/.test(text)) return 'The trade exceeds the local runner’s 10% price-impact safety bound. No execution was attempted.';
  return 'Unsigned review rejected the current VM state or explicit inputs. No execution was attempted.';
}
export class MaxWalletLocalSession {
  constructor({ transport, now = Date.now, reviewTtlMs = 30000, maxReviews = 32, maxHistory = 96, planBuilder = buildLocalPlan }) {
    this.transport = transport; this.now = now; this.reviewTtlMs = reviewTtlMs; this.maxReviews = maxReviews; this.maxHistory = maxHistory; this.planBuilder = planBuilder;
    this.vm = null; this.preparationRequest = null; this.reviews = new Map(); this.history = new Map(); this.busy = false; this.uncertain = false; this.unresolved = null;
  }
  async exclusive(fn) { if (this.busy) fail('UNAVAILABLE', 'Another local request is pending. Refresh state before continuing.', 409); this.busy = true; try { return await fn(); } finally { this.busy = false; } }
  async command(action, fields = {}, id = randomUUID()) {
    const request = { schema: 'hooklab/max-wallet-vm-request/1', id, action, expectedRevision: this.vm?.revision ?? 0, ...fields };
    const result = await this.transport.request(request);
    return validateVmResponse(result, request, this.vm);
  }
  async initialize() { return this.exclusive(async () => { this.vm = await this.command('state'); if (this.vm.status !== 'succeeded' || this.vm.phase !== 'unprepared' || this.vm.revision !== 0) throw Error('A fresh disposable VM is required'); return this.publicState(); }); }
  publicState() {
    if (!this.vm) fail('UNAVAILABLE', 'Local VM has not initialized.');
    const v = this.vm, map = vmAccounts(v), c = launchCoder.accounts.decode('Config', data(map, addresses.launchConfig));
    const a = account(map, addresses.policy), policy = a ? gateCoder.accounts.decode('Policy', Buffer.from(a.dataBase64, 'base64')) : null;
    const initialSupply = c.supply.toString(10), capBps = policy?.cap_bps ?? null;
    return { schema: 'repoing/max-wallet-local-state/1', mode: 'synthetic-sbf', sessionId: v.sessionId, revision: v.revision,
      phase: this.uncertain ? 'uncertain' : v.paused ? 'paused' : v.phase, policy: { capBps, rawCap: capBps === null ? null : String(BigInt(initialSupply) * BigInt(capBps) / 10000n), initialSupply },
      identities: { creator: preparationIdentity.creator, mint: preparationIdentity.mint, selectedConfig: preparationIdentity.selectedConfig, trader: preparationIdentity.creator },
      balances: { traderBaseRaw: v.balances.base, traderQuoteRaw: v.balances.quote }, supportedActions: this.uncertain ? [] : v.phase === 'unprepared' ? ['prepare'] : v.phase === 'prepared' ? ['launch'] : ['quote', 'buy', 'sell', 'pause'],
      canSign: false, canSubmit: false, productionPreparationReceiptAccepted: false, profileSha256: maxWalletFrozenPins.profileSha256, notice,
      slot: Number(v.slot), blockHeight: Number(v.blockHeight), blockhash: v.blockhash, paused: v.paused, historyDigest: v.historyDigest };
  }
  async state() { return this.exclusive(async () => {
    const prior = this.vm;
    try {
      const v = await this.command('state');
      if (v.status !== 'succeeded' || v.revision > prior.revision + Number(this.uncertain)) throw Error('Cannot reconcile VM');
      if (!this.uncertain && (v.historyDigest !== prior.historyDigest || canonicalJson(v.accounts) !== canonicalJson(prior.accounts))) throw Error('Unexpected VM state change');
      this.vm = v;
      // A current snapshot does not establish the exact outcome of an unresolved message.
      // Keep execution locked until the operator explicitly restarts this disposable VM.
      return this.publicState();
    } catch { this.uncertain = true; return this.publicState(); }
  }); }
  check(value) {
    if (this.uncertain) fail('UNAVAILABLE', 'The local outcome is unresolved. Restart the disposable session explicitly before further execution.', 503);
    if (value.expectedRevision !== this.vm.revision) fail('STALE_REVISION', 'The local revision changed. Refresh and review again.', 409);
    const phase = this.vm.phase;
    if (value.action === 'prepare' ? phase !== 'unprepared' : value.action === 'launch' ? phase !== 'prepared' : phase !== 'launched') fail('INVALID_INPUT', 'This action is unavailable at the current local step.');
  }
  remember(key, digest, result) { this.history.set(key, { digest, result }); }
  prior(kind, value) {
    const key = `${kind}:${value.requestId}`, digest = sha(canonicalJson(value)), prior = this.history.get(key);
    if (prior && prior.digest !== digest) fail('REVIEW_MISMATCH', 'Request identifier was already used with different inputs.', 409);
    if (prior) return { cached: structuredClone(prior.result) };
    if (this.history.size >= this.maxHistory) fail('UNAVAILABLE', 'This bounded disposable session is full. Restart it explicitly.');
    return { key, digest };
  }
  async review(raw) { const value = parseLocalAction(raw, 'review'); return this.exclusive(async () => {
    this.check(value); const tracked = this.prior('review', value); if (tracked.cached) return tracked.cached;
    const now = this.now(); for (const [id, row] of this.reviews) if (row.expiresAtMs <= now) this.reviews.delete(id);
    if (this.reviews.size >= this.maxReviews) fail('UNAVAILABLE', 'Too many pending reviews. Wait for their short expiry.');
    let plan; try { plan = this.planBuilder(value.action, value.input, this.vm, this.preparationRequest, now, this.reviewTtlMs); } catch (error) { fail('INVALID_INPUT', reviewError(error)); }
    const r = plan.review, bytes = Buffer.from(r.messageBase64, 'base64'), wireBytes = 1 + 64 * r.requiredSigners.length + bytes.length;
    if (!HASH.test(r.messageSha256) || sha(bytes) !== r.messageSha256 || wireBytes > 1232 || plan.canSign !== false || plan.canSubmit !== false) fail('UNAVAILABLE', 'Unsigned review failed its final message boundary.');
    const reviewId = randomUUID(), expiresAtMs = now + this.reviewTtlMs;
    this.reviews.set(reviewId, { action: value.action, inputDigest: sha(canonicalJson(value.input)), revision: value.expectedRevision, sessionId: this.vm.sessionId, plan, expiresAtMs });
    const result = { schema: 'repoing/max-wallet-local-review/1', requestId: value.requestId, reviewId, action: value.action, revision: this.vm.revision, sessionId: this.vm.sessionId,
      profileSha256: maxWalletFrozenPins.profileSha256, messageSha256: r.messageSha256, wireBytes, requiredSigners: r.requiredSigners, expiresAtMs, canSign: false, canSubmit: false };
    this.remember(tracked.key, tracked.digest, result); return result;
  }); }
  async action(raw) { const value = parseLocalAction(raw, 'action'); return this.exclusive(async () => {
    const tracked = this.prior('action', value); if (tracked.cached) return tracked.cached;
    this.check(value); let plan = null, fields = {};
    if (value.reviewId) {
      const row = this.reviews.get(value.reviewId);
      if (!row || row.expiresAtMs <= this.now()) fail('REVIEW_EXPIRED', 'The exact review expired or was consumed. Review again.', 409);
      if (row.action !== value.action || row.revision !== value.expectedRevision || row.sessionId !== this.vm.sessionId || row.inputDigest !== sha(canonicalJson(value.input))) fail('REVIEW_MISMATCH', 'The action no longer matches the exact reviewed inputs.', 409);
      plan = row.plan; fields = { plan };
    } else if (value.action === 'quote') fields = { direction: value.input.direction === 'buy' ? 1 : 0, amountIn: value.input.amountInRaw, slippageBps: 0 };
    else fields = { paused: value.input.paused };
    if (this.vm.paused && value.action !== 'pause') fail('INVALID_INPUT', 'The local program is paused. No execution was attempted.');
    let result;
    try {
      const v = await this.command(value.action, fields, value.requestId);
      if (v.status === 'rejected') fail('INVALID_INPUT', 'The local VM rejected the request before execution. Refresh or adjust explicit inputs.');
      this.vm = v;
      if (plan && value.action === 'prepare' && v.status === 'succeeded') this.preparationRequest = plan.request;
      if (value.action !== 'quote') this.reviews.clear();
      let quote;
      if (value.action === 'quote') {
        const q = vmQuote.parse(v.quote);
        if (q.direction !== fields.direction || q.amountIn !== value.input.amountInRaw) throw Error('Quote binding differs');
        quote = { direction: value.input.direction, amountInRaw: q.amountIn, amountOutRaw: q.delivered };
      }
      result = { schema: 'repoing/max-wallet-local-result/1', requestId: value.requestId, action: value.action, outcome: value.action === 'quote' ? 'quoted' : v.status,
        messageSha256: v.messageSha256, state: this.publicState(), ...(quote ? { quote } : {}), ...(v.status === 'program-failed' ? { error: 'The SBF program rejected the exact reviewed message. Token balances rolled back; the attempt consumed one revision.' } : {}), canSign: false, canSubmit: false };
    } catch (error) {
      if (error instanceof LocalError) throw error;
      this.uncertain = true; this.unresolved = { action: value.action, plan }; this.reviews.clear();
      result = { schema: 'repoing/max-wallet-local-result/1', requestId: value.requestId, action: value.action, outcome: 'unresolved', messageSha256: plan?.review.messageSha256 ?? null,
        state: this.publicState(), error: 'The local process outcome is unresolved. No automatic retry was made. Restart the disposable session explicitly before further execution.', canSign: false, canSubmit: false };
    }
    this.remember(tracked.key, tracked.digest, result); return result;
  }); }
  async close() { await this.transport.close(); }
}
