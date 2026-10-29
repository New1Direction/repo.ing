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
  {
    // Fourth bought-back REPOING lock from the custody buyback wallet (creator and recipient FgzeY…), 2026-10-05: 10M of
    // the 32,208,008.701 it held. Tx 4DX294EeqLeUbCuEETrNr1WBbqMkVNUJW6yEVdj8GjTU6Xhv9DRSMDBzG1HV5SDMjWkjpeBLeMRKv1ewSRiKedgT;
    // cancel_mode=0, update_recipient_mode=0.
    name: 'Bought-back REPOING 4',
    ...buyback,
    verifiedAt: '2026-10-11',
    escrow: 'BvjrV6JdzUo6MiAmkXNVSqFA8oyjVczcw9ZmyYYzVFS1',
    deposited: '10,000,000',
    supplyPercent: '1%',
    releases: [
      { at: '2026-11-05T05:43:08Z', amount: '1,500,000' },
      { at: '2026-12-05T15:43:08Z', amount: '8,500,000' },
    ],
  },
  {
    // Bought-back REPOING locked from the team wallet (creator and recipient 4euC…), 2026-09-29. Before this deposit the
    // team wallet held 41,747,842.333 REPOING after its original 45M was locked above and 48.78M of team-wallet
    // buybacks. Tx 4pSnyZgj3whvnjuyTqeVRumVRj5u7Qkn3YKbPrCmt7Vn53uwTgG6vvvukDmnjS6gp8Bjp3nVsbiLLVuhC5ZbmD4m.
    name: 'Team bought-back REPOING',
    ...team,
    boughtBack: true,
    verifiedAt: '2026-10-02',
    escrow: 'A2gXXqDX6H1wKCLj7tuKNpgay5jifUz2E3qQWWMEkffN',
    deposited: '21,000,000',
    supplyPercent: '2.1%',
    releases: [
      { at: '2026-10-31T18:07:44Z', amount: '5,000,000.000001' },
      { at: '2026-12-01T04:07:44Z', amount: '5,333,333.333333' },
      { at: '2026-12-31T14:07:44Z', amount: '5,333,333.333333' },
      { at: '2027-01-31T00:07:44Z', amount: '5,333,333.333333' },
    ],
  },
  {
    // Second team-wallet lock of bought-back REPOING, 2026-10-02: 18M of the 28,259,365.561 held after 59.77M of
    // team-wallet buybacks. Tx 4BL99V4UAUzaNgMaMyfBSkmQLZuGJUiqZFJ2T9V87vqPj5xsCf2L5fp9iZWUJHSG2rr7sBwoR1fwfhzjybz5ngmi.
    name: 'Team bought-back REPOING 2',
    ...team,
    boughtBack: true,
    verifiedAt: '2026-10-02',
    escrow: 'mjeZ4brBnmUiu7M5o7mG8TH8j2H6yGuEvDCFgx1Lnyz',
    deposited: '18,000,000',
    supplyPercent: '1.8%',
    releases: [
      { at: '2026-10-31T19:00:00Z', amount: '3,500,000' },
      { at: '2026-12-01T05:00:00Z', amount: '14,500,000' },
    ],
  },
  {
    // Third team-wallet lock of bought-back REPOING, 2026-10-08: 11,111,111 of the 29,367,535.670 held; the team wallet's
    // original deposit is the first two escrows above. The first 1,000,000 released at creation (cliff = start).
    // Tx 52Q8LUZNWGYuh3bT72YsgQziHr3cqfKZCurt2zxoNpeuNSkjM8uadYPdjeAuPQfq3PH7wMqo8ravhTdc57ZLW941.
    name: 'Team bought-back REPOING 3',
    ...team,
    boughtBack: true,
    verifiedAt: '2026-10-11',
    escrow: '778SLbkLxkgziHhMcaapiWErEavQQi8MNdXRCyvixmKF',
    deposited: '11,111,111',
    supplyPercent: '1.11%',
    releases: [
      { at: '2026-10-08T21:06:33Z', amount: '1,000,000' },
      { at: '2026-11-08T07:06:33Z', amount: '10,111,111' },
    ],
  },
  {
    // Fourth team-wallet lock of bought-back REPOING, 2026-10-29 (owner: "I locked the team tokens"). Decoded from the
    // finalized escrow account: canonical mint, creator and recipient the team wallet, cancel_mode=0,
    // update_recipient_mode=0, nothing claimed. Cliff 3,000,000 then two periods of 11,500,000 every 2,628,000 s.
    // Tx 4g1V8ZE6D5fkSzMLsizf7Mn7JnWtGtapBcnyHcjbT7HRsGbEeHeoe7A1EegKENVTUkhqNYHeLSBxEjKgKDoEC3Va.
    name: 'Team bought-back REPOING 4',
    ...team,
    boughtBack: true,
    verifiedAt: '2026-10-29',
    escrow: 'FoKA1YUSfn1YPqqfEeN3rioFYnY9nDJkx2Ktpu96Dt7n',
    deposited: '26,000,000',
    supplyPercent: '2.6%',
    releases: [
      { at: '2026-12-01T03:05:04Z', amount: '3,000,000' },
      { at: '2026-12-31T13:05:04Z', amount: '11,500,000' },
      { at: '2027-01-30T23:05:04Z', amount: '11,500,000' },
    ],
  },
]

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = (n, one, many) => `${COUNT_WORDS[n] ?? n} ${n === 1 ? one : many}`
const capitalized = text => text[0].toUpperCase() + text.slice(1)

// Provenance note derived from the published locks, so adding a lock never leaves a stale count. A team-wallet lock
// marked boughtBack holds REPOING the team wallet bought back, not its original deposit.
export function lockNote(locks = OFFICIAL_TEAM_LOCKS) {
  const original = locks.filter(lock => lock.source === 'team' && !lock.boughtBack).length
  const byBuyback = locks.filter(lock => lock.source === 'buyback').length
  const byTeam = locks.filter(lock => lock.source === 'team' && lock.boughtBack).length
  const bought = byBuyback + byTeam
  const depositors = byBuyback && byTeam ? `, ${COUNT_WORDS[byBuyback] ?? byBuyback} deposited by the buyback wallet and ${COUNT_WORDS[byTeam] ?? byTeam} by the team wallet`
    : ` deposited by the ${byBuyback ? 'buyback' : 'team'} wallet`
  const parts = [
    original && `${count(original, 'lock is an original team deposit', 'locks are original team deposits')} from the team wallet`,
    bought && `${count(bought, 'lock holds', 'locks hold')} bought-back $REPOING${depositors}`,
  ].filter(Boolean)
  if (!parts.length) return ''
  return `${capitalized(parts.join('; '))}. All are existing-supply tokens, separate from the 1% builder allocation after graduation and from other wallet holdings.`
}

// '5,666,666.666666' (whole tokens) -> base units. $REPOING has 6 decimals (mint_facts; app/lib/buyback-summary.mjs).
const TOKEN_DECIMALS = 6
const baseUnits = amount => {
  const [whole, fraction = ''] = amount.replaceAll(',', '').split('.')
  return BigInt(whole) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(fraction.padEnd(TOKEN_DECIMALS, '0').slice(0, TOKEN_DECIMALS))
}
// $REPOING `wallet` deposited into these locks and cannot move yet: each deposit less the releases already due (released
// tokens are claimable, so they count as held again). The launcher row subtracts this so locked tokens never read as held.
export function lockedBaseUnits(wallet, now = Date.now(), locks = OFFICIAL_TEAM_LOCKS) {
  return stillLockedBaseUnits(now, locks.filter(lock => lock.wallet.address === wallet))
}
// One lock's tokens that have not released yet (its deposit less the releases already due).
export function lockStillLocked(lock, now = Date.now()) {
  const released = lock.releases.filter(r => Date.parse(r.at) <= now).reduce((s, r) => s + baseUnits(r.amount), 0n)
  const left = baseUnits(lock.deposited) - released
  return left > 0n ? left : 0n
}
// Every published lock's tokens that cannot move yet: the one "locked" figure the token page and /stats show (Launch
// facts' holders row and the Token locks list), so they always agree.
export function stillLockedBaseUnits(now = Date.now(), locks = OFFICIAL_TEAM_LOCKS) {
  return locks.reduce((sum, lock) => sum + lockStillLocked(lock, now), 0n)
}
// The next release still to come: { at, amount } or null when every release is due.
export const nextRelease = (lock, now = Date.now()) => lock.releases.find(release => Date.parse(release.at) > now) ?? null
