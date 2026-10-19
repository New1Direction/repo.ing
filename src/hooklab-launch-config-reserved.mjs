// The launch Config's reserved bytes 186..249 (Config.reserved[0..64]) as the reviewed launch programs write them:
//   [0]       byte 186, native launches (governed_set_native_launches): 0 or 1
//   [1]       byte 187, open creation: 0 or 1
//   [2..10)   creator-fee menu (bytes 188..196): 4 u16 LE bps slots, values in use first and strictly ascending, then 0
//   [10..18)  wallet-cap menu (bytes 196..204): the same shape, 1..9999
//   [18..64)  bytes 204..250, zero
// Open creation on requires both menus non-empty (governed_set_open_creation refuses otherwise). The fee ceiling
// (Config.max_creator_fee_bps) is checked by the open-launch compiler, which reads the whole Config. One check for every
// compiler that reads the launch Config (preparation, launch and trade). Pure. Layout: hook-lab feat/open-creation ABI.
export const LAUNCH_CONFIG_RESERVED_AT = 186
export const OPEN_CREATION_LAYOUT = Object.freeze({ native: 0, open: 1, feeMenu: 2, capMenu: 10, slots: 4, end: 18 })
const L = OPEN_CREATION_LAYOUT

function menuAt(reserved, at) {
  const values = Array.from({ length: L.slots }, (_, i) => reserved[at + 2 * i] | (reserved[at + 2 * i + 1] << 8))
  const used = values.findIndex(v => v === 0), menu = used === -1 ? values : values.slice(0, used)
  if (values.slice(menu.length).some(v => v !== 0) || menu.some(v => v > 9999) || menu.some((v, i) => i > 0 && v <= menu[i - 1])) return null
  return menu
}
// { native, open, creatorFeeBps: [...], capBps: [...] }, or null for any state the reviewed programs never write.
export function parseLaunchConfigReserved(reserved) {
  if (!reserved || reserved.length !== 64) return null
  const flag = reserved[L.native], open = reserved[L.open]
  if (![0, 1].includes(flag) || ![0, 1].includes(open)) return null
  if (Array.prototype.slice.call(reserved, L.end).some(v => v !== 0)) return null
  const creatorFeeBps = menuAt(reserved, L.feeMenu), capBps = menuAt(reserved, L.capMenu)
  if (!creatorFeeBps || !capBps || (open === 1 && (!creatorFeeBps.length || !capBps.length))) return null
  return { native: flag === 1, open: open === 1, creatorFeeBps, capBps }
}
export const launchConfigReservedValid = reserved => parseLaunchConfigReserved(reserved) !== null
// The 64 reserved bytes for a state (the owner driver's preview and tests). Refuses anything parse would refuse.
export function encodeOpenCreationReserved({ native, open, creatorFeeBps, capBps }) {
  const out = Buffer.alloc(64)
  out[L.native] = native ? 1 : 0; out[L.open] = open ? 1 : 0
  for (const [at, menu] of [[L.feeMenu, creatorFeeBps], [L.capMenu, capBps]]) {
    if (!Array.isArray(menu) || menu.length > L.slots) throw Error(`a menu holds at most ${L.slots} choices`)
    menu.forEach((v, i) => out.writeUInt16LE(v, at + 2 * i))
  }
  if (!launchConfigReservedValid(out)) throw Error('menus must be strictly ascending bps values from 1 to 9999, and both non-empty to open creation')
  return out
}
