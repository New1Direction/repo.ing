import { z } from 'zod';
import { API_VERSION, boardSchema, calendarSchema, eventsSchema, liquiditySchema, mintSchema,
  transparencySchema, eventKinds, type EventKind, type LaunchEvent, type LiquiditySnapshot } from './contracts.js';

export type ErrorCode = 'http' | 'network' | 'timeout' | 'aborted' | 'contract' | 'limit' | 'stale';
export class MarketDataError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly status?: number) {
    super(message); this.name = 'MarketDataError';
  }
}
export interface Observation {
  event: 'request' | 'response' | 'retry' | 'error' | 'snapshot';
  operation: string;
  attempt?: number;
  status?: number;
  delayMs?: number;
  durationMs?: number;
  code?: ErrorCode;
}
export interface ClientOptions {
  baseUrl?: string;
  /** Explicit opt-in to real network reads. Otherwise provide a fixture fetch implementation. */
  liveData?: boolean;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  minIntervalMs?: number;
  maxResponseBytes?: number;
  observe?: (event: Readonly<Observation>) => void;
}
export interface RequestOptions { signal?: AbortSignal }
export interface EventQuery extends RequestOptions { after?: string; limit?: number; kinds?: readonly EventKind[]; repos?: readonly string[] }

function bounded(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be ${min}..${max}`);
  return value;
}
function aborted(signal: AbortSignal): never { throw signal.reason ?? new MarketDataError('aborted', 'Request aborted'); }
async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const stop = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([promise, stop]); }
  finally { signal.removeEventListener('abort', cancel); }
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
    // Node overflows longer timers to 1 ms. The request deadline (<= 5 minutes) always wins this cap.
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, Math.min(ms, 2_147_483_647));
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
function retryAfter(value: string | null): number {
  if (!value) return 0;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

/** Node 22+; GET-only, cookie-free, no credentials, redirects, signing, or transaction submission. */
export class MarketDataClient {
  readonly #base: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeout: number;
  readonly #retries: number;
  readonly #interval: number;
  readonly #maxBytes: number;
  readonly #observe: ClientOptions['observe'];
  #tail: Promise<unknown> = Promise.resolve();
  #nextAt = 0;
  #pending = 0;
  #metrics = { requests: 0, retries: 0, errors: 0, snapshots: 0 };

  constructor(options: ClientOptions = {}) {
    if (!options.liveData && !options.fetch) throw new Error('Network disabled: set liveData: true or inject a fixture fetch');
    const base = new URL(options.baseUrl ?? 'https://repo.ing');
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      throw new Error('baseUrl must be a credential-free HTTPS origin');
    }
    this.#base = base.origin;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = bounded(options.timeoutMs ?? 30_000, 1, 300_000, 'timeoutMs');
    this.#retries = bounded(options.maxRetries ?? 2, 0, 5, 'maxRetries');
    this.#interval = bounded(options.minIntervalMs ?? 2100, options.liveData ? 2100 : 0, 60_000, 'minIntervalMs');
    this.#maxBytes = bounded(options.maxResponseBytes ?? 2_000_000, 1, 10_000_000, 'maxResponseBytes');
    this.#observe = options.observe;
  }
  get metrics() { return { ...this.#metrics }; }
  #emit(event: Observation) { try { this.#observe?.(Object.freeze(event)); } catch { /* Telemetry cannot change a result. */ } }

  async #get<T>(path: string, operation: string, schema: z.ZodType<T>, options: RequestOptions): Promise<T> {
    if (this.#pending >= 100) throw new MarketDataError('limit', 'At most 100 pending reads per client');
    this.#pending++;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new MarketDataError('timeout', 'Request deadline exceeded')), this.#timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    const started = Date.now();
    const task = this.#tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        await wait(Math.max(0, this.#nextAt - Date.now()), signal);
        this.#nextAt = Date.now() + this.#interval;
        this.#metrics.requests++;
        this.#emit({ event: 'request', operation, attempt });
        let response: Response;
        try {
          response = await cancellable(this.#fetch(`${this.#base}${path}`, {
            method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' }, signal,
          }), signal);
        } catch {
          if (signal.aborted) aborted(signal);
          if (attempt >= this.#retries) throw new MarketDataError('network', 'Market data transport failed');
          this.#backoff(operation, attempt, 0);
          continue;
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          const delay = retryAfter(response.headers.get('retry-after'));
          // Shared cooldown also survives an exhausted request; never shorten a server Retry-After.
          this.#nextAt = Math.max(this.#nextAt, Date.now() + delay);
          if (!retryable || attempt >= this.#retries) throw new MarketDataError('http', `Market data HTTP ${response.status}`, response.status);
          this.#backoff(operation, attempt, delay, response.status);
          continue;
        }
        if (response.headers.get('x-repoing-api-version') !== API_VERSION) {
          void response.body?.cancel().catch(() => {});
          throw new MarketDataError('contract', 'Missing or unsupported API version');
        }
        if (!response.headers.get('content-type')?.includes('application/json')) {
          void response.body?.cancel().catch(() => {});
          throw new MarketDataError('contract', 'Expected JSON market data');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new MarketDataError('contract', 'Empty response body');
        const decoder = new TextDecoder();
        let size = 0, body = '';
        try {
          for (;;) {
            const part = await cancellable(reader.read(), signal);
            if (part.done) break;
            size += part.value.byteLength;
            if (size > this.#maxBytes) throw new MarketDataError('limit', 'Market data response too large');
            body += decoder.decode(part.value, { stream: true });
          }
          body += decoder.decode();
        } finally { void reader.cancel().catch(() => {}); }
        try { return schema.parse(JSON.parse(body)); }
        catch { throw new MarketDataError('contract', 'Market data does not match the audited contract'); }
      }
    });
    this.#tail = task.catch(() => {});
    try {
      const result = await cancellable(task, signal);
      this.#emit({ event: 'response', operation, durationMs: Date.now() - started });
      return result;
    }
    catch (error) {
      const result = signal.aborted
        ? (deadline.signal.aborted && !options.signal?.aborted ? deadline.signal.reason : new MarketDataError('aborted', 'Request aborted'))
        : error instanceof MarketDataError ? error : new MarketDataError('network', 'Market data stream failed');
      this.#metrics.errors++;
      this.#emit({ event: 'error', operation, code: result.code, durationMs: Date.now() - started });
      throw result;
    } finally { clearTimeout(timer); this.#pending--; }
  }
  #backoff(operation: string, attempt: number, serverDelay: number, status?: number) {
    const delayMs = Math.max(serverDelay, Math.min(10_000, 250 * 2 ** attempt) * (1 + Math.random()));
    this.#nextAt = Math.max(this.#nextAt, Date.now() + delayMs);
    this.#metrics.retries++;
    this.#emit({ event: 'retry', operation, attempt, delayMs, ...(status === undefined ? {} : { status }) });
  }
  liquidity(mint: string, options: RequestOptions = {}) {
    mintSchema.parse(mint);
    return this.#get(`/api/v1/markets/${mint}/liquidity`, 'liquidity',
      liquiditySchema.refine(value => value.market.mint === mint), options);
  }
  board(options: RequestOptions = {}) { return this.#get('/api/v1/liquidity', 'board', boardSchema, options); }
  calendar(options: RequestOptions = {}) { return this.#get('/api/v1/launches', 'calendar', calendarSchema, options); }
  transparency(mint: string, options: RequestOptions = {}) {
    mintSchema.parse(mint);
    return this.#get(`/api/v1/markets/${mint}/transparency`, 'transparency',
      transparencySchema.refine(value => value.market.mint === mint), options);
  }
  events(query: EventQuery = {}) {
    const params = new URLSearchParams();
    if (query.after !== undefined) {
      if (!/^\d{1,18}$/.test(query.after)) throw new RangeError('after must be an event ID string');
      params.set('after', query.after);
    }
    if (query.limit !== undefined) params.set('limit', String(bounded(query.limit, 1, 200, 'limit')));
    if (query.kinds?.length) {
      if (query.kinds.some(kind => !eventKinds.includes(kind))) throw new RangeError('Unknown event kind');
      params.set('kind', query.kinds.join(','));
    }
    if (query.repos?.length) {
      if (query.repos.length > 50 || query.repos.some(repo => !/^[1-9]\d{0,15}$/.test(repo))) throw new RangeError('Invalid repository IDs');
      params.set('repo', query.repos.join(','));
    }
    return this.#get(`/api/v1/launches/events?${params}`, 'events', eventsSchema, query);
  }
  /** Drain forward from an explicit checkpoint (default 0). Never follow a server-provided URL. */
  async *iterateEvents(query: EventQuery & { maxPages?: number } = {}): AsyncGenerator<LaunchEvent> {
    const maxPages = bounded(query.maxPages ?? 100, 1, 10_000, 'maxPages');
    let after = query.after ?? '0';
    for (let page = 0; page < maxPages; page++) {
      const result = await this.events({ ...query, after });
      if (!result.events.length) return;
      // Validate the whole page before yielding any of it. Gaps from filters are legitimate.
      let previous = BigInt(after);
      for (const event of result.events) {
        if (BigInt(event.id) <= previous) throw new MarketDataError('contract', 'Event cursor did not advance in order');
        previous = BigInt(event.id);
      }
      for (const event of result.events) { yield event; after = event.id; }
    }
    throw new MarketDataError('limit', 'Event page budget exhausted; resume after the last processed ID');
  }
  /** Backpressure-aware polling; errors terminate, checkpoints belong to the consumer. */
  async *watchLiquidity(mint: string, options: RequestOptions & { intervalMs?: number; maxAgeMs?: number } = {}): AsyncGenerator<LiquiditySnapshot> {
    const interval = bounded(options.intervalMs ?? 15_000, 10_000, 3_600_000, 'intervalMs');
    const age = bounded(options.maxAgeMs ?? 45_000, 1, 300_000, 'maxAgeMs');
    let last = -Infinity;
    for (;;) {
      const snapshot = await this.liquidity(mint, options);
      const at = Date.parse(snapshot.liquidity.checkedAt), now = Date.now();
      if (now - at > age || at > now + 5000 || at < last) throw new MarketDataError('stale', 'Stale, future, or regressing liquidity snapshot');
      if (at > last) {
        last = at; this.#metrics.snapshots++;
        this.#emit({ event: 'snapshot', operation: 'liquidity' });
        yield snapshot;
      }
      await wait(interval, options.signal);
    }
  }
}
