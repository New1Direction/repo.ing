import { z } from 'zod';

export const API_VERSION = '2026-10-13';
// String IDs and amounts must never pass through floating-point numbers.
const amount = z.string().regex(/^\d{1,80}$/);
const id = z.string().regex(/^\d{1,18}$/);
const timestamp = z.iso.datetime({ offset: true });
const nullableBps = z.number().int().nonnegative().nullable();
const extra = z.record(z.string(), z.unknown());
export const mintSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const eventKinds = ['launch.scheduled', 'launch.schedule_cancelled', 'launch.window_open',
  'launch.schedule_lapsed', 'market.launched', 'market.graduated', 'group_launch.raising',
  'group_launch.launched', 'group_launch.failed'] as const;
export type EventKind = typeof eventKinds[number];

const market = z.object({ repoId: id, mint: mintSchema, symbol: z.string() });
export const liquiditySchema = z.object({
  market,
  liquidity: z.object({
    version: z.literal(1), venue: z.enum(['curve', 'damm']), pool: mintSchema,
    sqrtPrice: amount.refine(value => BigInt(value) > 0n),
    lamportsPerToken: z.string().regex(/^\d+(\.\d+)?$/), feeBps: nullableBps,
    quoteReserveLamports: amount.nullable(), thresholdLamports: amount.nullable(),
    depth: z.array(z.object({ impactPercent: z.number().positive(), buyLamports: amount,
      buyTokens: amount, sellTokens: amount, sellLamports: amount })),
    spreads: z.array(z.object({ sizeLamports: amount, askToSpotPpm: amount.nullable(),
      bidToSpotPpm: amount.nullable(), spreadBps: nullableBps })),
    summary: z.object({ buyDepthLamports: amount, sellDepthLamports: amount, spreadBps: nullableBps,
      twoSided: z.boolean(), feeBps: z.number().int().nonnegative() }),
    checkedAt: timestamp,
  }),
  note: z.string(),
});
export type LiquiditySnapshot = z.infer<typeof liquiditySchema>;

export const eventsSchema = z.object({
  events: z.array(z.object({ id, kind: z.enum(eventKinds), repoId: id, occurredAt: timestamp,
    recordedAt: timestamp, data: extra })),
  kinds: z.array(z.string()), next: z.string().nullable(),
});
export type EventPage = z.infer<typeof eventsSchema>;
export type LaunchEvent = EventPage['events'][number];

export const boardSchema = z.object({
  generatedAt: timestamp,
  markets: z.array(market.extend({ fullName: z.string(), sampledAt: timestamp, venue: z.enum(['curve', 'damm']),
    pool: mintSchema, feeBps: nullableBps, quoteReserveLamports: amount.nullable(), buyDepthLamports: amount,
    sellDepthLamports: amount, spreadBps: nullableBps, twoSided: z.boolean(),
    sustained: extra.nullable(), incentives: extra.nullable() })),
  impactPercent: z.literal(2), spreadSizeLamports: z.literal('100000000'),
  incentives: z.object({ status: z.literal('preview'), paid: z.literal(false), qualifies: z.string() }),
});
export type LiquidityBoard = z.infer<typeof boardSchema>;

export const calendarSchema = z.object({
  generatedAt: timestamp,
  scheduled: z.array(z.object({ id: z.string(), repoId: id, fullName: z.string().nullable(),
    state: z.enum(['upcoming', 'open']), scheduledAt: timestamp, windowEndsAt: timestamp,
    windowMinutes: z.number().positive(), launcherWallet: mintSchema, maxInitialBuyLamports: amount,
    note: z.string().nullable(), announcedBy: z.string(), announcedAt: timestamp })),
  groupLaunches: z.array(z.object({ bundleId: z.string(), repoId: id, fullName: z.string(), symbol: z.string(),
    targetLamports: amount, deadline: timestamp, path: z.string() })),
  recentLaunches: z.array(market.extend({ launcherWallet: mintSchema, launchedAt: timestamp,
    groupLaunch: z.boolean(), path: z.string(), quality: extra.nullable() })),
});
export type LaunchCalendar = z.infer<typeof calendarSchema>;

// Reports evolve independently; unknown report facts are intentionally not asserted as execution inputs.
export const transparencySchema = z.object({
  market: market.extend({ pool: mintSchema, fullName: z.string().nullable() }), generatedAt: timestamp,
  report: extra.nullable(), liquidity: extra.nullable(), seeded: z.unknown(),
  mechanism: z.object({ stages: z.array(extra), notLive: z.array(z.unknown()) }),
  schedule: extra.nullable(), disclosures: z.array(z.string()),
});
export type Transparency = z.infer<typeof transparencySchema>;
