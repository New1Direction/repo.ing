// The blocks a hooks coin is built from, as creators see them. Live blocks launch today through the owner-approved
// flow (src/hooklab-launch-menus.mjs holds their choices); the rest are shown as coming soon. Pure, for pages and UI.
export const HOOK_BLOCKS = Object.freeze([
  { id: 'max-wallet', title: 'Max wallet', icon: '/hook-icons/max-wallet.webp?v=2', live: true,
    summary: 'Cap how much of the supply one wallet can hold until your coin graduates.' },
  { id: 'creator-fee', title: 'Creator fee', icon: '/hook-icons/creator-rewards.webp?v=2', live: true,
    summary: 'Earn a fee on every buy and sell, paid out in SOL.' },
  { id: 'burns', title: 'Trade burns', icon: '/hook-icons/burns.webp?v=2', live: false,
    summary: 'Burn a share of your coin on every buy or sell.' },
  { id: 'locks', title: 'Wallet locks', icon: '/hook-icons/locks.webp?v=2', live: false,
    summary: 'Lock the creator wallet, and early buyers if you like, for a set time after launch.' },
  { id: 'half-life', title: 'Half-life', icon: '/hook-icons/half-life.webp?v=2', live: false,
    summary: 'Quick flips burn up to 20% on the way out, halving every 6 hours.' },
  { id: 'holder-rewards', title: 'Holder rewards', icon: '/hook-icons/plain.webp?v=2', live: false,
    summary: 'Drip part of every trade to the people holding your coin.' },
].map(Object.freeze))

export const LIVE_BLOCKS = HOOK_BLOCKS.filter(block => block.live)
export const SOON_BLOCKS = HOOK_BLOCKS.filter(block => !block.live)
export const hookBlock = id => HOOK_BLOCKS.find(block => block.id === id)
