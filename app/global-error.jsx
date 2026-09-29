'use client'
import { THEME_SCRIPT } from './lib/theme-script.mjs'
// Replaces the root layout when it crashes, so it can't rely on globals.css, providers, or the header.
const css = ':root{color-scheme:dark;--bg:#0f1214;--text:#eef1f4;--muted:#aab4bf;--green:#2ec47c}[data-theme=light]{color-scheme:light;--bg:#f7f9f7;--text:#19221c;--muted:#59685d;--green:#14955a}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:520px;text-align:center}h1{font-size:32px;line-height:1.1;margin:0 0 10px}p{color:var(--muted);margin:0 0 22px}button,a{font:inherit;font-weight:700;border-radius:8px;padding:10px 18px;margin:4px}button{border:1px solid var(--green);background:var(--green);color:#101713;cursor:pointer}a{color:var(--text);border:1px solid var(--muted);text-decoration:none;display:inline-block}button:focus-visible,a:focus-visible{outline:2px solid var(--green);outline-offset:2px}'

export default function GlobalError({ retry }) {
  return <html lang="en" suppressHydrationWarning><head><title>Something went wrong — repo.ing</title><style dangerouslySetInnerHTML={{ __html: css }}/><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}/></head>
    <body><main role="alert"><h1>repo.ing couldn’t load</h1><p>Please try again. Check any pending wallet transaction before submitting another.</p><button type="button" onClick={() => retry()}>Try again</button><a href="/">Go home</a></main></body></html>
}
