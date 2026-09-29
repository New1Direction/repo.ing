export const defaultTokenName = repoName => String(repoName || '').slice(0, 32)
export const defaultTokenSymbol = repoName => String(repoName || '').replace(/[^a-z0-9]/gi, '').slice(0, 10).toUpperCase()
// Mirrors the agent-draft schema (src/agent-launch-draft.mjs); only decides whether the customize panel may stay closed.
export const tokenDetailsComplete = ({ name, symbol, image }) =>
  typeof name === 'string' && name.trim().length > 0 && name.length <= 32 && !/[\x00-\x1f\x7f]/.test(name) &&
  typeof symbol === 'string' && /^[A-Z0-9]{1,10}$/.test(symbol) && !!image
