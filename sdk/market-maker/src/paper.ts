import { liquiditySchema, mintSchema, type LiquiditySnapshot } from './contracts.js';

const Q128 = 1n << 128n;
const BPS = 10_000n;
const DENOMINATOR = Q128 * BPS;
const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;

export interface PaperOptions {
  mint: string;
  controller: string;
  /** All wallets/identities under common control, not just the quoting wallet. */
  relatedControllers?: readonly string[];
  cashLamports: bigint;
  tokenBaseUnits: bigint;
  maxInventoryBaseUnits: bigint;
  maxQuoteLamports?: bigint;
  maxTurnoverLamports?: bigint;
  maxDrawdownLamports?: bigint;
  halfSpreadBps?: number;
  feeBps?: number;
  maxAgeMs?: number;
}
export interface PaperQuote {
  id: string;
  side: 'bid' | 'ask';
  tokenBaseUnits: bigint;
  /** Exact lamports per token base unit. Not SOL per whole token. */
  priceNumerator: bigint;
  priceDenominator: bigint;
  expiresAt: number;
}
export interface PaperFill {
  id: string;
  quoteId: string;
  counterpartyController: string;
  tokenBaseUnits: bigint;
  now: number;
}

/** Deterministic bookkeeping, NOT an execution venue or an AMM/queue-position predictor. No I/O. */
export class PaperMarketMaker {
  readonly #options: Required<Omit<PaperOptions, 'relatedControllers'>>;
  readonly #blocked: Set<string>;
  #cash: bigint;
  #tokens: bigint;
  #turnover = 0n;
  #fees = 0n;
  #spot = 0n;
  #peak = 0n;
  #initialEquity: bigint | undefined;
  #clock = -Infinity;
  #snapshotAt = -Infinity;
  #revision = 0;
  #quotes: PaperQuote[] = [];
  #fills = new Set<string>();
  #stopped: string | null = null;

  constructor(options: PaperOptions) {
    mintSchema.parse(options.mint);
    if (!options.controller.trim()) throw new Error('A controller identity is required');
    const full = { ...options, maxQuoteLamports: options.maxQuoteLamports ?? 100_000_000n,
      maxTurnoverLamports: options.maxTurnoverLamports ?? 1_000_000_000n,
      maxDrawdownLamports: options.maxDrawdownLamports ?? 100_000_000n,
      halfSpreadBps: options.halfSpreadBps ?? 200, feeBps: options.feeBps ?? 100, maxAgeMs: options.maxAgeMs ?? 45_000 };
    for (const key of ['cashLamports', 'tokenBaseUnits', 'maxInventoryBaseUnits', 'maxQuoteLamports',
      'maxTurnoverLamports', 'maxDrawdownLamports'] as const) {
      if (typeof full[key] !== 'bigint' || full[key] < 0n) throw new RangeError(`${key} must be nonnegative bigint`);
    }
    if (full.cashLamports > 10_000_000_000n || full.tokenBaseUnits > full.maxInventoryBaseUnits ||
      full.maxInventoryBaseUnits <= 0n || full.maxInventoryBaseUnits > 1_000_000_000_000_000n ||
      full.maxQuoteLamports < 1n || full.maxQuoteLamports > 100_000_000n ||
      full.maxTurnoverLamports < 1n || full.maxTurnoverLamports > 1_000_000_000n ||
      full.maxDrawdownLamports < 1n || full.maxDrawdownLamports > 1_000_000_000n) throw new RangeError('Paper capital or risk limit exceeded');
    for (const [value, low, high] of [[full.halfSpreadBps, 1, 2000], [full.feeBps, 0, 500], [full.maxAgeMs, 1, 45_000]] as const) {
      if (!Number.isSafeInteger(value) || value < low || value > high) throw new RangeError('Invalid paper spread, fee, or age limit');
    }
    this.#options = full;
    this.#blocked = new Set([options.controller, ...(options.relatedControllers ?? [])]);
    this.#cash = options.cashLamports; this.#tokens = options.tokenBaseUnits;
  }
  get quotes(): readonly PaperQuote[] { return this.#quotes.map(quote => ({ ...quote })); }
  get metrics() {
    const equity = this.#cash + this.#tokens * this.#spot / Q128;
    return { cashLamports: this.#cash, tokenBaseUnits: this.#tokens, turnoverLamports: this.#turnover,
      feesLamports: this.#fees, fills: this.#fills.size, equityLamports: this.#initialEquity === undefined ? null : equity,
      pnlLamports: this.#initialEquity === undefined ? null : equity - this.#initialEquity, stopped: this.#stopped };
  }
  stop(reason = 'operator stop') { this.#stopped = reason; this.#quotes = []; }
  #time(now: number) {
    if (!Number.isSafeInteger(now) || now < this.#clock) throw new Error('Paper clock must be monotonic integer milliseconds');
    this.#clock = now;
    if (this.#stopped) throw new Error(`Paper maker stopped: ${this.#stopped}`);
  }
  #risk() {
    const equity = this.#cash + this.#tokens * this.#spot / Q128;
    this.#initialEquity ??= equity;
    if (equity > this.#peak) this.#peak = equity;
    if (this.#peak - equity >= this.#options.maxDrawdownLamports) this.stop('drawdown limit');
    if (this.#turnover >= this.#options.maxTurnoverLamports || this.#fills.size >= 10_000) this.stop('session budget exhausted');
  }
  /** Cancel/replace atomically. Any bad snapshot latches the kill switch; create a new session after investigation. */
  update(input: LiquiditySnapshot, now: number): readonly PaperQuote[] {
    this.#quotes = [];
    try {
      this.#time(now);
      const snapshot = liquiditySchema.parse(input), value = snapshot.liquidity;
      const at = Date.parse(value.checkedAt);
      // Match the public feed's bounded server/client clock-skew tolerance; never rewrite the source timestamp.
      if (snapshot.market.mint !== this.#options.mint || at > now + 5000 || now - at >= this.#options.maxAgeMs || at < this.#snapshotAt) {
        throw new Error('Wrong market or stale, future, or regressing snapshot');
      }
      const depth = value.depth.find(row => row.impactPercent === 2);
      if (!depth || !value.summary.twoSided || value.feeBps === null || value.feeBps > this.#options.feeBps) {
        throw new Error('Two-sided depth and a known fee within the paper fee budget are required');
      }
      this.#snapshotAt = at;
      this.#spot = BigInt(value.sqrtPrice) ** 2n;
      this.#risk();
      if (this.#stopped) return this.quotes;
      const remaining = this.#options.maxTurnoverLamports - this.#turnover;
      const quoteBudget = min(this.#options.maxQuoteLamports, remaining);
      const bidPrice = this.#spot * (BPS - BigInt(this.#options.halfSpreadBps));
      const askPrice = this.#spot * (BPS + BigInt(this.#options.halfSpreadBps));
      // At most 1% of the reported 2% depth. Cash includes the worst configured paper fee.
      const bidBudget = min(quoteBudget, BigInt(depth.buyLamports) / 100n,
        this.#cash * BPS / (BPS + BigInt(this.#options.feeBps)));
      const bidSize = min(bidBudget * DENOMINATOR / bidPrice, this.#options.maxInventoryBaseUnits - this.#tokens);
      const askSize = min(quoteBudget * DENOMINATOR / askPrice, BigInt(depth.sellTokens) / 100n, this.#tokens);
      this.#revision++;
      for (const [side, size, price] of [['bid', bidSize, bidPrice], ['ask', askSize, askPrice]] as const) {
        if (size > 0n && size * price / DENOMINATOR > 0n) this.#quotes.push({ id: `${this.#revision}:${side}`, side,
          tokenBaseUnits: size, priceNumerator: price, priceDenominator: DENOMINATOR, expiresAt: at + this.#options.maxAgeMs });
      }
      return this.quotes;
    } catch (error) { this.stop('invalid market data or clock'); throw error; }
  }
  /** Fill only from explicit external tape events; the two sides can NEVER match each other. */
  fill(fill: PaperFill) {
    this.#time(fill.now);
    if (!fill.id || this.#fills.has(fill.id)) throw new Error('Fill ID must be unique');
    if (!fill.counterpartyController.trim() || this.#blocked.has(fill.counterpartyController)) throw new Error('Self-trades and related-controller trades are prohibited');
    const quote = this.#quotes.find(row => row.id === fill.quoteId);
    if (!quote) throw new Error('Quote is not active');
    if (fill.now >= quote.expiresAt) { this.stop('expired quote'); throw new Error('Quote expired'); }
    if (typeof fill.tokenBaseUnits !== 'bigint' || fill.tokenBaseUnits <= 0n || fill.tokenBaseUnits > quote.tokenBaseUnits) throw new RangeError('Fill exceeds quote size');
    const product = fill.tokenBaseUnits * quote.priceNumerator;
    // Conservative integer rounding: pay up on buys, receive down on sells; fees always round up.
    const notional = quote.side === 'bid' ? ceil(product, DENOMINATOR) : product / DENOMINATOR;
    const fee = ceil(notional * BigInt(this.#options.feeBps), BPS);
    if (notional <= fee || notional + this.#turnover > this.#options.maxTurnoverLamports) throw new Error('Dust fill or turnover limit');
    if (quote.side === 'bid') {
      if (notional + fee > this.#cash || this.#tokens + fill.tokenBaseUnits > this.#options.maxInventoryBaseUnits) throw new Error('Cash or inventory limit');
      this.#cash -= notional + fee; this.#tokens += fill.tokenBaseUnits;
    } else {
      if (fill.tokenBaseUnits > this.#tokens) throw new Error('No short selling');
      this.#cash += notional - fee; this.#tokens -= fill.tokenBaseUnits;
    }
    this.#fees += fee; this.#turnover += notional; this.#fills.add(fill.id);
    // Every fill cancels BOTH sides: prevents reusing stale inventory reservations or a round-trip fill pair.
    this.#quotes = [];
    this.#risk();
    return { mode: 'paper' as const, side: quote.side, notionalLamports: notional, feeLamports: fee, ...this.metrics };
  }
}
