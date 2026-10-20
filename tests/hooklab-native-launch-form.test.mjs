// Reserve input for the native launcher: an invited coin launches with exactly its approved details,
// without asking the creator for operator-only fields.
import test from 'node:test'
import assert from 'node:assert/strict'
import { STANDARD_VIRTUAL_QUOTE, lockedLaunchFields, reservationInput } from '../app/lib/hooklab-native-launch-form.mjs'
import { sameLaunchHook } from '../app/lib/hooklab-open-launch.mjs'

const empty = { label: '', name: '', symbol: '', uri: '', capBps: '', creatorFeeBps: '', virtualQuote: '' }
const invited = { name: 'Repo Cat Test', symbol: 'RCATT', uri: '', creatorFeeBps: 100, capBps: 200 }

const selected = { ...invited, capBps: 0, selectedHook: { program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', flags: 255 } }
test('selected reserve serializes explicit flags and cap zero, and reviewed identity wins', () => {
  for (const flags of [1, 128, 255, '3']) {
    const input = reservationInput(empty, { ...selected, selectedHook: { ...selected.selectedHook, flags } })
    assert.deepEqual(input.selectedHook, { ...selected.selectedHook, flags: Number(flags) })
    assert.equal(input.capBps, 0)
  }
  assert.deepEqual(reservationInput({ selectedHook: { program: 'bad', flags: 0 }, hookKind: 'max-wallet', capBps: 200 }, selected).selectedHook, selected.selectedHook)
  assert.equal(reservationInput({ selectedHook: selected.selectedHook, hookKind: 'selected' }, invited).selectedHook, undefined)
})

test('selected reserve rejects malformed programs, flags, and any invented gate cap', () => {
  for (const program of ['', 'bad', '0'.repeat(44), '11111111111111111111111111111111', `${selected.selectedHook.program} `])
    assert.throws(() => reservationInput(empty, { ...selected, selectedHook: { ...selected.selectedHook, program } }), /program address/)
  for (const flags of [0, 256, -1, 1.5, '', '1e2', '0x01', ' 1', true])
    assert.throws(() => reservationInput(empty, { ...selected, selectedHook: { ...selected.selectedHook, flags } }), /flags must/)
  assert.throws(() => reservationInput(empty, { ...selected, capBps: 200 }), /cap of 0/)
  assert.throws(() => reservationInput(empty, { ...invited, capBps: 0 }), /Max-wallet cap/)
})

test('recovery compares the exact hook program, flags and cap without falling back to the gate', () => {
  assert.equal(sameLaunchHook(selected, { ...selected, selectedHook: { ...selected.selectedHook, flags: '255' } }), true)
  for (const changed of [invited, { ...selected, selectedHook: undefined }, { ...selected, capBps: 200 },
    { ...selected, selectedHook: { ...selected.selectedHook, flags: 1 } },
    { ...selected, selectedHook: { ...selected.selectedHook, program: 'So11111111111111111111111111111111111111112' } }])
    assert.equal(sameLaunchHook(selected, changed), false)
  assert.equal(sameLaunchHook(invited, { ...invited }), true)
})

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

test('a USD-priced invite reserves at exactly its fixed opening price', () => {
  const priced = { ...invited, virtualQuote: '53251917070' }
  assert.equal(reservationInput(empty, priced).virtualQuote, '53251917070')
  assert.equal(reservationInput({ ...empty, virtualQuote: '1000000000' }, priced).virtualQuote, '53251917070', 'typed values never win')
  assert.equal(lockedLaunchFields(priced).virtualQuote, '53251917070')
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
