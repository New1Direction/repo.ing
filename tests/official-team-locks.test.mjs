import test from 'node:test'
import assert from 'node:assert/strict'
import { LOCK_WALLETS, OFFICIAL_TEAM_LOCKS, lockNote } from '../app/lib/official-team-locks.mjs'
import { BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'

const baseUnits = value => { const [whole, frac = ''] = value.replaceAll(',', '').split('.'); return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0')) }

test('each lock names its on-chain creator and recipient wallet', () => {
  assert.equal(LOCK_WALLETS.team.address, OFFICIAL_TOKEN.teamWallet)
  assert.equal(LOCK_WALLETS.buyback.address, BUYBACK_WALLETS.custody)
  for (const lock of OFFICIAL_TEAM_LOCKS) {
    assert.equal(lock.wallet, LOCK_WALLETS[lock.source], lock.name)
    assert.match(lock.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, lock.name)
  }
  const bySource = source => OFFICIAL_TEAM_LOCKS.filter(lock => lock.source === source).map(lock => lock.name)
  assert.deepEqual(bySource('team'), ['repo.ing team', 'Repo.ing team 2', 'Team bought-back REPOING', 'Team bought-back REPOING 2'])
  assert.deepEqual(bySource('buyback'), ['Bought-back REPOING', 'Bought-back REPOING 2', 'Bought-back REPOING 3'])
})

test('release amounts sum exactly to each deposit and the total is 129M (12.9%)', () => {
  let total = 0n
  for (const lock of OFFICIAL_TEAM_LOCKS) {
    const released = lock.releases.reduce((sum, release) => sum + baseUnits(release.amount), 0n)
    assert.equal(released, baseUnits(lock.deposited), lock.name)
    assert.equal(lock.supplyPercent, `${+(Number(lock.deposited.replaceAll(',', '')) / 1e7).toFixed(2)}%`, lock.name)
    total += baseUnits(lock.deposited)
  }
  assert.equal(total, 129_000_000n * 1_000_000n)
})

test('the provenance note counts locks by source instead of hard-coding them', () => {
  assert.equal(lockNote(), 'Two locks are original team deposits from the team wallet; five locks hold bought-back $REPOING, three deposited by the buyback wallet and two by the team wallet. All are existing-supply tokens, separate from the 1% builder allocation after graduation and from other wallet holdings.')
  const teamBoughtBack = OFFICIAL_TEAM_LOCKS.find(lock => lock.source === 'team' && lock.boughtBack)
  assert.match(lockNote([teamBoughtBack]), /^One lock holds bought-back \$REPOING deposited by the team wallet\. /)
  const [teamLock] = OFFICIAL_TEAM_LOCKS
  const buybackLock = OFFICIAL_TEAM_LOCKS.find(lock => lock.source === 'buyback')
  assert.match(lockNote([teamLock]), /^One lock is an original team deposit from the team wallet\. /)
  assert.match(lockNote([buybackLock]), /^One lock holds bought-back \$REPOING deposited by the buyback wallet\. /)
  assert.equal(lockNote([]), '')
})
