// Compiled as an external tarball consumer in CI: exercises exports and shipped declarations.
import { MarketDataClient, PaperMarketMaker, type LiquiditySnapshot, type LaunchEvent } from '@repoing/market-maker';

const client = new MarketDataClient({ liveData: true });
async function consume(mint: string) {
  const snapshot: LiquiditySnapshot = await client.liquidity(mint);
  const id: string = snapshot.market.repoId;
  // @ts-expect-error Amount strings must not silently become floating point.
  const unsafe: number = snapshot.liquidity.sqrtPrice;
  const maker = new PaperMarketMaker({ mint, controller: id, cashLamports: 100n, tokenBaseUnits: 10n, maxInventoryBaseUnits: 20n });
  const quotes = maker.update(snapshot, Date.now());
  const amount: bigint | undefined = quotes[0]?.tokenBaseUnits;
  for await (const event of client.iterateEvents({ after: '0' })) {
    const typed: LaunchEvent = event;
    console.log(typed.id, amount, unsafe);
  }
}
void consume; // Type check only; never contacts a service.
