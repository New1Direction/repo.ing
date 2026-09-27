const scriptValue = value => JSON.stringify(value).replaceAll('<', '\\u003c')

export function claimProgressStream(run, failureUrl) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      const write = html => { try { controller.enqueue(encoder.encode(html)) } catch { /* Keep the claim running if the browser closes. */ } }
      write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Processing claim · repo.ing</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101213;color:#f4f6fa;font:16px system-ui,-apple-system,sans-serif;padding:24px}.card{width:min(100%,480px);padding:32px;border:1px solid #38433d;border-radius:14px;background:#171b19}.brand{font-size:23px;font-weight:750;margin-bottom:36px}.brand span{color:#81e6ad}.spinner{width:30px;height:30px;border:3px solid #496b56;border-top-color:#81e6ad;border-radius:50%;animation:spin .8s linear infinite}h1{font-size:28px;line-height:1.15;margin:23px 0 10px}p{color:#b8c6bd;line-height:1.5;margin:0}.note{font-size:13px;margin-top:24px}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none;border-color:#81e6ad}}</style></head><body><main class="card" role="status" aria-live="polite"><div class="brand">repo.<span>ing</span></div><div class="spinner" aria-hidden="true"></div><h1>Processing your claim</h1><p id="claim-stage">Checking GitHub approval and the current claim state…</p><p class="note">Keep this page open. A receipt appears after the payout is verified.</p></main>`)
      Promise.resolve().then(async () => {
        let destination = failureUrl
        try {
          destination = await run(stage => write(`<script>document.getElementById("claim-stage").textContent=${scriptValue(stage)}</script>`))
        } catch { /* The caller records a safe failure URL before throwing. */ }
        write(`<script>location.replace(${scriptValue(destination)})</script></body></html>`)
        try { controller.close() } catch { /* The browser may already have left. */ }
      })
    },
  })
}
