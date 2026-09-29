import { createRateLimiter, cspStats, handleCspReport } from '../../lib/csp-report.mjs'

const limiter = createRateLimiter()

export async function POST(request) { return handleCspReport(request, { limiter, stats: cspStats() }) }
