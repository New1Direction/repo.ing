// The stack's modes: which program set the validator loads, which owner decisions and website switches apply, whether
// the owner agent runs, and which suites run against it (file filters for the e2e runner).
//   native      the owner-approved native-SOL release (E1 happy path, E2 edges); owner agent on
//   legacy      what mainnet runs today, unchanged: bundle-2 programs, the production bridge and bridged SOL (Add SOL,
//               Withdraw), owner-approved bridged launches; native switches off; owner agent on
//   self-serve  ownerless open launches on the open-creation build: NO owner agent process, no invites, no grants;
//               the owner's menus and creation fee are governed on chain (owner decisions 2026-10-19)
// HOOKS_E2E_SELF_SERVE_SET picks the self-serve program set (default: the open-creation build at the legacy IDs, until
// the independent-stack set lands).
export const OWNER_MENUS = Object.freeze({ creatorFeeBps: Object.freeze([50, 100, 200]), capBps: Object.freeze([100, 200, 300, 500]) })
export const CREATION_FEE_LAMPORTS = 20_000_000n

export const MODES = Object.freeze({
  native: Object.freeze({ set: () => 'native-e357fdf', ownerAgent: true, suites: ['native-release', 'release-edges'], decisions: {}, env: {} }),
  legacy: Object.freeze({ set: () => 'legacy-bundle-2', ownerAgent: true, suites: ['legacy-holder'], decisions: {},
    env: { HOOK_NATIVE_LAUNCHES_ENABLED: 'false', HOOK_NATIVE_TRADING_ENABLED: 'false', HOOK_WALLET_FUNDING_ENABLED: 'true', HOOK_LAUNCH_USD_PRICING: 'false' } }),
  'self-serve': Object.freeze({ set: () => process.env.HOOKS_E2E_SELF_SERVE_SET ?? 'native-open-36dd07e', ownerAgent: false, suites: ['self-serve'],
    decisions: { openCreationMenus: { creatorFeeBps: [...OWNER_MENUS.creatorFeeBps], capBps: [...OWNER_MENUS.capBps] }, launchFeeLamports: String(CREATION_FEE_LAMPORTS) },
    env: { HOOK_OPEN_LAUNCHES: 'true', HOOK_OWNER_APPROVED_LAUNCHES: 'false' } }),
})
export const MODE_NAMES = Object.freeze(Object.keys(MODES))
