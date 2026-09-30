import { database, marketByMint } from '../../../../lib/server.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  const pool = database()
  if (!market || !pool) return Response.json({ error: 'Market unavailable' }, { status: 404 })
  try {
    const [trades, fees, claims, parts] = await Promise.all([
      pool.query(`select signature, event_index as "eventIndex", direction, traded_at as "occurredAt",
        input_base_units as "inputBaseUnits", output_base_units as "outputBaseUnits"
        from trade_events where pool = $1 order by slot desc, event_index desc limit 30`, [market.pool]),
      pool.query(`select f.signature, f.event_index as "eventIndex", f.amount_base_units::text as "amountBaseUnits",
        coalesce(t.traded_at, f.created_at) as "occurredAt" from fee_events f
        left join lateral (select traded_at from trade_events t where t.pool = f.pool and t.signature = f.signature
          order by t.event_index limit 1) t on true
        where f.github_repo_id = $1 order by f.slot desc, f.event_index desc limit 30`, [market.repoId]),
      pool.query(`select claim_signature as signature, amount_base_units::text as "amountBaseUnits",
        settled_at as "occurredAt" from repo_claims where github_repo_id = $1 and status = 'settled'
        order by settled_at desc limit 15`, [market.repoId]),
      // Parts fund: confirmed pledges and build updates (text only here; the card shows the photos).
      pool.query(`(select 'parts-pledge' as type, p.signature, p.id::text as ref, p.confirmed_at as "occurredAt", p.received_amount::text as "amountBaseUnits",
          p.symbol, p.decimals, p.usd_cents::int as "usdCents", null as body from parts_pledges p
          where p.github_repo_id=$1 and p.status in ('confirmed','paid','refunded') order by p.confirmed_at desc limit 15)
        union all
        (select 'parts-update', null, u.id::text, u.created_at, null, null, null, null, left(u.body, 160) from parts_updates u
          where u.github_repo_id=$1 order by u.created_at desc limit 10)`, [market.repoId]).catch(error => {
        if (error?.code === '42P01') return { rows: [] }
        throw error
      }),
    ])
    const events = [
      ...trades.rows.map(row => ({ type: row.direction, signature: row.signature, eventIndex: row.eventIndex,
        occurredAt: row.occurredAt?.toISOString(), inputBaseUnits: row.inputBaseUnits, outputBaseUnits: row.outputBaseUnits })),
      ...fees.rows.map(row => ({ type: 'fee', signature: row.signature, eventIndex: row.eventIndex,
        occurredAt: row.occurredAt?.toISOString(), amountBaseUnits: row.amountBaseUnits })),
      ...claims.rows.map(row => ({ type: 'claim', signature: row.signature,
        occurredAt: row.occurredAt?.toISOString(), amountBaseUnits: row.amountBaseUnits })),
      ...parts.rows.map(row => ({ type: row.type, signature: row.signature, ref: row.ref, occurredAt: row.occurredAt?.toISOString(),
        ...(row.type === 'parts-pledge' ? { amountBaseUnits: row.amountBaseUnits, symbol: row.symbol, decimals: row.decimals, usdCents: row.usdCents } : { body: row.body }) })),
    ].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 40)
    return Response.json({ events }, { headers: { 'Cache-Control': 'no-store' } })
  } catch { return Response.json({ error: 'Activity is temporarily unavailable' }, { status: 503 }) }
}
