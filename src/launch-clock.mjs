// Markets whose policy is measured from launch (discovery rewards, the verification bonus window) record the finalized
// DBC pool's activationPoint as launch_block_time, the same on-chain clock swap events use, rather than the RPC's
// estimated block time. Every other market keeps the transaction's block time.
export const usesActivationClock = market => Boolean(market.discoveryVersion) ||
  (market.verificationBonusLamports !== null && market.verificationBonusLamports !== undefined)
