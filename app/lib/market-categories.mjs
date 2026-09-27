// Conservative, deterministic labels from cached repository metadata. A repository
// may belong to multiple categories; unmatched projects remain discoverable in Other.
export const MARKET_CATEGORIES = [
  { id: 'ai', label: 'AI & agents', pattern: /\b(ai|agents?|llms?|language models?|machine learning|inference|neural|generative|chatbot|gpts?|claude|transformers?|finetuning|non autoregressive|decision engine)\b/i },
  { id: 'tools', label: 'Developer tools', pattern: /\b(developer|devtools?|sdk|cli|ide|editor|debugger|linter|compiler|framework|coding|code review|testing|terminal|bundler)\b/i },
  { id: 'infra', label: 'Infrastructure', pattern: /\b(infrastructure|database|storage|distributed|server|cloud|kubernetes|docker|networking|deployment|observability|monitoring|backend)\b/i },
  { id: 'games', label: 'Games', pattern: /\b(games?|gaming|gameplay|game engine|godot|unity|unreal|emulator)\b/i },
  { id: 'other', label: 'Other' },
]
export function marketCategories(market) {
  const text = `${market.name || market.fullName?.split('/').at(-1) || ''} ${market.description || ''}`.replace(/[-_]/g, ' ')
  const matches = MARKET_CATEGORIES.filter(category => category.pattern?.test(text)).map(category => category.id)
  return matches.length ? matches : ['other']
}
