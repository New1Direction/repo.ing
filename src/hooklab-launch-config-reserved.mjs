// The launch Config's reserved bytes 186..249 (Config.reserved[0..64]) as the reviewed launch programs write them:
// byte 186 is the native-launches switch (governed_set_native_launches), 0 or 1; every later byte stays zero. One check
// for every compiler that reads the launch Config (preparation and launch). Pure.
export const LAUNCH_CONFIG_RESERVED_AT = 186
export const launchConfigReservedValid = reserved => !!reserved && reserved.length === 64
  && (reserved[0] === 0 || reserved[0] === 1) && Array.prototype.slice.call(reserved, 1).every(v => v === 0)
