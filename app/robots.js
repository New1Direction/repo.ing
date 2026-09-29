// Operator pages are gated and noindex already; keep crawlers off them entirely.
// AI crawlers get the same rules, listed explicitly so the allow is unambiguous. LLM index: /llms.txt.
const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended']
const rule = userAgent => ({ userAgent, allow: '/', disallow: ['/operations/'] })

export default function robots() {
  return {
    rules: [rule('*'), rule(AI_CRAWLERS)],
    sitemap: 'https://repo.ing/sitemap.xml',
  }
}
