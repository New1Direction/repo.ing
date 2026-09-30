// Published terms verified against two finalized RPCs on 2026-09-28.
// Original deposits and immutable release schedules, not live unclaimed balances.
// Jupiter program: LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn.
// Both escrows: official mint, team creator/recipient, cancel_mode=0,
// update_recipient_mode=0. Evidence and exact base units: docs/REPO_IDENTITY.md.
export const OFFICIAL_TEAM_LOCKS = [
  {
    name: 'repo.ing team',
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
    escrow: '9SFbDcqyhRQc6WX2sR1mSQcrzFETDLV3XpT7rEs8To9x',
    deposited: '10,000,000',
    supplyPercent: '1%',
    releases: [
      { at: '2026-10-16T06:40:02Z', amount: '1,000,000' },
      { at: '2026-11-15T16:40:02Z', amount: '9,000,000' },
    ],
  },
]
