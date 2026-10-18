// Reserve input for the native launcher: an invited coin launches with exactly its approved details,
// without asking the creator for operator-only fields.
import test from 'node:test'
import assert from 'node:assert/strict'
import { STANDARD_VIRTUAL_QUOTE, lockedLaunchFields, reservationInput } from '../app/lib/hooklab-native-launch-form.mjs'

const empty = { label: '', name: '', symbol: '', uri: '', capBps: '', creatorFeeBps: '', virtualQuote: '' }
const invited = { name: 'Repo Cat Test', symbol: 'RCATT', uri: '', creatorFeeBps: 100, capBps: 200 }

test('an invited coin reserves with its approved details even though the form was never typed in', () => {
  assert.deepEqual(reservationInput(empty, invited),
    { label: 'RCATT', name: 'Repo Cat Test', symbol: 'RCATT', uri: '', capBps: 200, creatorFeeBps: 100, virtualQuote: STANDARD_VIRTUAL_QUOTE })
  assert.equal(STANDARD_VIRTUAL_QUOTE, '1000000000', 'the reviewed curve input every launch uses')
})

test('approved details win over anything typed, and are sent exactly as approved', () => {
  const typed = { ...empty, name: 'Other', symbol: 'OTH', capBps: '500', creatorFeeBps: '50', virtualQuote: '5', label: 'mine' }
  const input = reservationInput(typed, { ...invited, name: ' Spaced Name ' })
  assert.equal(input.name, ' Spaced Name ', 'not trimmed: the server compares against the stored request')
  assert.deepEqual([input.symbol, input.capBps, input.creatorFeeBps, input.virtualQuote, input.label], ['RCATT', 200, 100, STANDARD_VIRTUAL_QUOTE, 'RCATT'])
})

test('lockedLaunchFields lists what the creator cannot edit after an invite', () => {
  assert.deepEqual(lockedLaunchFields(null), {})
  assert.deepEqual(Object.keys(lockedLaunchFields(invited)).sort(), ['capBps', 'creatorFeeBps', 'label', 'name', 'symbol', 'uri', 'virtualQuote'])
})

test('an approved metadata URL must still be HTTPS when present', () => {
  assert.equal(reservationInput(empty, { ...invited, uri: 'https://repo.ing/m.json' }).uri, 'https://repo.ing/m.json')
  assert.throws(() => reservationInput(empty, { ...invited, uri: 'http://repo.ing/m.json' }), /HTTPS metadata URL/)
})

test('without an invite the operator form keeps its explicit checks', () => {
  const filled = { label: 'ops', name: 'Coin', symbol: 'CN', uri: 'https://repo.ing/m.json', capBps: '300', creatorFeeBps: '50', virtualQuote: '1000000000' }
  assert.deepEqual(reservationInput(filled), { ...filled, capBps: 300, creatorFeeBps: 50 })
  assert.throws(() => reservationInput(empty), /Max-wallet cap must be 1–9999 basis points/)
  assert.throws(() => reservationInput({ ...filled, virtualQuote: '' }), /virtual quote/)
  assert.throws(() => reservationInput({ ...filled, uri: '' }), /Enter uri/)
  assert.throws(() => reservationInput({ ...filled, symbol: 'ELEVENBYTES' }), /symbol must be at most 10 UTF-8 bytes/)
})
