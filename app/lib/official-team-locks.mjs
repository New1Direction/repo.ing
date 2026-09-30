import { OFFICIAL_TOKEN } from './official-token.mjs'
import { BUYBACK_WALLETS } from './buyback-receipts.mjs'

// Original deposits and immutable release schedules, not live unclaimed balances.
// Jupiter program: LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn. Every escrow: official mint,
// cancel_mode=0, update_recipient_mode=0; `wallet` is both its on-chain creator and recipient.
// `verifiedAt` is the date the finalized escrow account was last checked against these terms.
// Evidence and exact base units: docs/REPO_IDENTITY.md.
export const LOCK_WALLETS = Object.freeze({
  team: Object.freeze({ label: 'team wallet', address: OFFICIAL_TOKEN.teamWallet }),
  buyback: Object.freeze({ label: 'buyback wallet', address: BUYBACK_WALLETS.custody }),
})
const team = { source: 'team', wallet: LOCK_WALLETS.team }
const buyback = { source: 'buyback', wallet: LOCK_WALLETS.buyback }

export const OFFICIAL_TEAM_LOCKS = [
  {
    name: 'repo.ing team',
    ...team,
    verifiedAt: '2026-09-28',
    escrow: '2g8rPU4cm7DpETb9Df1q96FL5eShCnAf57AN4Hf2NnSb',
    deposited: '20,000,000',
    supplyPercent: '2%',
    releases: [
      { at: '2026-11-27T22:00:00Z', amount: '3,000,000.000002' },
      { at: '2026-12-28T08:00:00Z', amount: '5,666,666.666666' },
      { at: '2027-01-27T18:00:00Z', amount: '5,666,666.666666' },
      { at: '2027-02-27T04:00:00Z', amount: '5,666,666.666666' },
    ],
  },
  {
    name: 'Repo.ing team 2',
    ...team,
    verifiedAt: '2026-09-28',
    escrow: 'FKy62zAHFhhg25bGNTRBQ2sT1dGnB6BSiwSQWXmyR9f7',
    deposited: '25,000,000',
    supplyPercent: '2.5%',
    releases: [
      { at: '2026-11-01T03:28:37Z', amount: '5,000,000' },
      { at: '2026-12-01T13:28:37Z', amount: '10,000,000' },
      { at: '2026-12-31T23:28:37Z', amount: '10,000,000' },
    ],
  },
  {
    // Bought-back REPOING from the custody buyback wallet (creator and recipient FgzeY…), locked 2026-09-29.
    // Tx 5o2bVi8himm1jEsoQBHaFX5RyuxcSxMCxEUQYqDDQYq5Txx2AwjHmusYaKBvXB7HJEdVdphfSqVhWorEwQGKnFSX; cancel_mode=0, update_recipient_mode=0.
    name: 'Bought-back REPOING',
    ...buyback,
    verifiedAt: '2026-09-30',
    escrow: '4LKFWNwfiKTjMEfEPvq2rD5ZVKkBjmnmJXvNuADjHyJt',
    deposited: '23,000,000',
    supplyPercent: '2.3%',
    releases: [
      { at: '2026-10-05T15:00:00Z', amount: '3,000,000' },
      { at: '2026-11-05T01:00:00Z', amount: '10,000,000' },
      { at: '2026-12-05T11:00:00Z', amount: '10,000,000' },
    ],
  },
  {
    // Second bought-back REPOING lock from the custody buyback wallet (creator and recipient FgzeY…), 2026-09-30.
    // Tx 2mgXckenKuBpcEdxNXK4A3e8Symw63X8uZoUHv8fokvUJo8YDVx84CXmJr5CNew8kY3KuhwTVCSNtVBJSxWp3uYN; cancel_mode=0, update_recipient_mode=0.
    name: 'Bought-back REPOING 2',
    ...buyback,
    verifiedAt: '2026-09-30',
    escrow: 'DySLi6B9AUSeSx1gDrEAyovetF6AktaxcxAMJNLMUj5Q',
    deposited: '12,000,000',
    supplyPercent: '1.2%',
    releases: [
      { at: '2026-10-02T02:54:46Z', amount: '200,000' },
      { at: '2026-11-01T12:54:46Z', amount: '11,800,000' },
    ],
  },
  {
    // Third bought-back REPOING lock from the custody buyback wallet (creator and recipient FgzeY…), 2026-09-30.
    // Tx 3rwockyqB1FH5qr8wUJghAik5DnWvcpTkzpyLuRGxRdkk2wMsdXkKzuk6ca3tyzttKuACRvPerPDkgsy8bpPnMwu; cancel_mode=0, update_recipient_mode=0.
    name: 'Bought-back REPOING 3',
    ...buyback,
    verifiedAt: '2026-09-30',
    escrow: '9SFbDcqyhRQc6WX2sR1mSQcrzFETDLV3XpT7rEs8To9x',
    deposited: '10,000,000',
    supplyPercent: '1%',
    releases: [
      { at: '2026-10-16T06:40:02Z', amount: '1,000,000' },
      { at: '2026-11-15T16:40:02Z', amount: '9,000,000' },
    ],
  },
]

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = (n, one, many) => `${COUNT_WORDS[n] ?? n} ${n === 1 ? one : many}`
const capitalized = text => text[0].toUpperCase() + text.slice(1)

// Provenance note derived from the published locks, so adding a lock never leaves a stale count.
export function lockNote(locks = OFFICIAL_TEAM_LOCKS) {
  const teamCount = locks.filter(lock => lock.source === 'team').length
  const buybackCount = locks.filter(lock => lock.source === 'buyback').length
  const parts = [
    teamCount && `${count(teamCount, 'lock is an original team deposit', 'locks are original team deposits')} from the team wallet`,
    buybackCount && `${count(buybackCount, 'lock holds', 'locks hold')} bought-back $REPOING deposited by the buyback wallet`,
  ].filter(Boolean)
  if (!parts.length) return ''
  return `${capitalized(parts.join('; '))}. All are existing-supply tokens, separate from the 1% builder allocation after graduation and from other wallet holdings.`
}
