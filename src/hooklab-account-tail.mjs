// Bytes a Hook account may hold after its encoded data. AcceptAdmin/CancelNomination clear a governance's pending
// nomination (Some -> None encodes 40 bytes shorter) and the programs leave the old candidate and expiry in place
// (mainnet, 2026-10-27). Only that exact remnant is allowed beside all-zero padding; nothing else is.
const NOMINATION_BYTES = 40
export const allowedTail = (name, value, tail) => tail.every(b => b === 0)
  || (name === 'Governance' && value?.state?.pending_admin === null && tail.length === NOMINATION_BYTES)
