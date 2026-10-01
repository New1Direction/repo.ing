import { createMarketNotifications } from '../../src/market-notifications.mjs'

// The process's one LISTEN connection for market update hints (live streams and the chart cache share it).
export function marketNotificationHub() {
  if (!process.env.DATABASE_URL) return null
  return globalThis.__repoingMarketNotifications ??= createMarketNotifications({ connectionString: process.env.DATABASE_URL })
}
