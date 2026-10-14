import { MarketDataClient, PaperMarketMaker, mintSchema } from '../dist/index.js';
import { snapshot, mint as paperMint, start } from './tape.mjs';

// No environment variables, wallet files, signers, private RPCs, or transaction endpoints.
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--live-data' && !/^--mint=/.test(arg) && !/^--ticks=/.test(arg))) {
  throw new Error('Only --live-data, --mint=<mint>, --ticks=1..10 are supported. Live trading is unavailable.');
}
const live = args.includes('--live-data');
const ticks = Number(args.find(arg => arg.startsWith('--ticks='))?.slice(8) ?? 5);
if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10) throw new Error('ticks must be 1..10');
const mint = live ? mintSchema.parse(args.find(arg => arg.startsWith('--mint='))?.slice(7)) : paperMint;
if (!live && args.some(arg => arg.startsWith('--mint='))) throw new Error('--mint requires explicit --live-data');
const log = value => console.log(JSON.stringify(value, (_, value) => typeof value === 'bigint' ? value.toString() : value));
const maker = new PaperMarketMaker({ mint, controller: 'paper-maker', relatedControllers: ['paper-treasury'],
  cashLamports: 1_000_000_000n, tokenBaseUnits: 100_000_000n, maxInventoryBaseUnits: 200_000_000n,
  feeBps: 500 });
const stop = new AbortController();
const onStop = () => { maker.stop('signal'); stop.abort(); };
process.once('SIGINT', onStop); process.once('SIGTERM', onStop);
log({ mode: live ? 'live-data/paper-quotes' : 'simulation', execution: 'disabled', ticks });
try {
  if (live) {
    const client = new MarketDataClient({ liveData: true, observe: event => log({ transport: event }) });
    let count = 0;
    // A wall-clock deadline also bounds runs when the API keeps returning the same cached timestamp.
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(180_000)]);
    for await (const value of client.watchLiquidity(mint, { signal })) {
      log({ quotes: maker.update(value, Date.now()), paper: maker.metrics });
      // No synthetic fills from live quotes. Never infer a fill from a snapshot price crossing.
      if (++count >= ticks || maker.metrics.stopped) break;
    }
    log({ transport: client.metrics });
  } else {
    for (let tick = 0; tick < ticks; tick++) {
      const quotes = maker.update(snapshot(tick), start + tick * 15_000);
      log({ tick, quotes });
      // Exogenous fictional customers buy inventory from the paper ask. No buy/sell loop or self-match.
      const ask = quotes.find(quote => quote.side === 'ask');
      if (ask) log({ fill: maker.fill({ id: `customer-${tick}`, quoteId: ask.id, counterpartyController: `external-customer-${tick}`,
        tokenBaseUnits: 1_000_003n, now: start + tick * 15_000 + 1 }) });
      if (maker.metrics.stopped) break;
    }
  }
} catch (error) {
  log({ stopped: true, code: error.code ?? error.name, message: error.message });
  if (!stop.signal.aborted) process.exitCode = 1;
} finally {
  maker.stop('example ended');
  process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop);
  log({ paper: maker.metrics });
}
