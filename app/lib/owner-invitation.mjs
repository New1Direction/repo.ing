import { formatUnits } from './format.mjs'
export function ownerInvitation({ repoId, fullName, available, origin = 'https://repo.ing' }) {
  const amount = typeof available === 'string' && /^\d+$/.test(available) ? BigInt(available) : null
  const fees = amount === null ? 'Check whether builder fees are available to claim.' : amount === 0n
    ? 'Future trades can earn builder fees for your repository.' : `${formatUnits(amount)} SOL in builder fees is available as of this check. The balance may change.`
  return `${fullName} has a community-created market on repo.ing. ${fees}\n\nCurrent repository admins can verify with GitHub, set a payout wallet, and claim here:\n${origin}/claim/${encodeURIComponent(repoId)}\n\nGitHub access is read-only. repo.ing cannot edit your code. A community-created market does not imply endorsement by the repository owner.`
}
