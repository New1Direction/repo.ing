import { formatSolRounded } from './format.mjs'

const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
export function earningsBadge({ earned, fullName = '', unavailable = false }) {
  const label = 'repo.ing · builder fees'
  const value = unavailable ? 'unavailable' : `${formatSolRounded(earned)} SOL`
  const left = 137, right = Math.max(82, value.length * 7 + 20), width = left + right
  const title = unavailable ? 'Builder earnings unavailable' : `${fullName}: ${value} in indexed builder fees earned, including paid and unpaid fees`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="24" viewBox="0 0 ${width} 24" role="img" aria-label="${xml(title)}"><title>${xml(title)}</title><clipPath id="r"><rect width="${width}" height="24" rx="5"/></clipPath><g clip-path="url(#r)"><path fill="#24292f" d="M0 0h${left}v24H0z"/><path fill="#dafbe1" d="M${left} 0h${right}v24H${left}z"/></g><rect x=".5" y=".5" width="${width - 1}" height="23" rx="4.5" fill="none" stroke="#57606a" stroke-opacity=".35"/><g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="11" text-anchor="middle"><text x="${left / 2}" y="16" fill="#fff">${label}</text><text x="${left + right / 2}" y="16" fill="#116329">${xml(value)}</text></g></svg>`
}
export function badgeMarkdown(repoId, mint) {
  if (!/^[1-9]\d{0,17}$/.test(String(repoId)) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw Error('Invalid market')
  return `[![Builder fees earned on repo.ing](https://repo.ing/api/badge/${repoId})](https://repo.ing/token/${mint})`
}
