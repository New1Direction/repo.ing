// Wallets treated as one controller (docs/LAUNCH_TRANSPARENCY.md#linked-wallets). Three kinds of evidence, all public:
//   same-transaction  two different swap owners in one transaction: one signer assembled both swaps;
//   operator          a link an operator recorded in wallet_links with written evidence (scripts/wallet-links.mjs);
//   platform          every wallet repo.ing labels as its own (team, buyback, fee, signer, vault) is one controller.
// Wallets with no evidence stay separate, so linked activity is undercounted, never invented: funding-source analysis is
// a later phase. A cluster's id is its lexicographically smallest wallet, so ids are stable and need no storage.

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function createClusters() {
  const parent = new Map()
  const find = wallet => {
    let root = wallet
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)
    // Path compression keeps repeated lookups flat.
    let node = wallet
    while (parent.has(node) && parent.get(node) !== root) { const next = parent.get(node); parent.set(node, root); node = next }
    return root
  }
  const add = wallet => { if (!parent.has(wallet)) parent.set(wallet, wallet) }
  const link = (a, b) => {
    add(a); add(b)
    const ra = find(a), rb = find(b)
    if (ra === rb) return
    // The smaller wallet becomes the root, so a cluster's id never depends on the order links arrive in.
    if (ra < rb) parent.set(rb, ra)
    else parent.set(ra, rb)
  }
  return {
    add, link,
    clusterOf: wallet => (parent.has(wallet) ? find(wallet) : wallet),
    // wallet → cluster id for every wallet seen, and the members of every cluster with more than one wallet.
    snapshot() {
      const clusterOf = new Map([...parent.keys()].map(wallet => [wallet, find(wallet)]))
      const members = new Map()
      for (const [wallet, root] of clusterOf) members.set(root, [...(members.get(root) ?? []), wallet])
      return { clusterOf, linked: new Map([...members].filter(([, wallets]) => wallets.length > 1).map(([root, wallets]) => [root, wallets.sort()])) }
    },
  }
}

// events: [{ signature, trader }]. Different traders in one signature are one controller.
export function sameTransactionLinks(events) {
  const bySignature = new Map()
  for (const event of events ?? []) {
    if (!event?.signature || typeof event.trader !== 'string' || !event.trader) continue
    const traders = bySignature.get(event.signature) ?? new Set()
    traders.add(event.trader)
    bySignature.set(event.signature, traders)
  }
  const links = []
  for (const [signature, traders] of bySignature) {
    const list = [...traders].sort()
    for (let i = 1; i < list.length; i++) links.push({ a: list[0], b: list[i], kind: 'same-transaction', evidence: signature })
  }
  return links
}

// Every labeled platform wallet is one controller (repo.ing). Builder payout wallets are not merged with the platform.
export function platformLinks(labels) {
  const platform = [...(labels ?? new Map())].filter(([, label]) => label?.kind && label.kind !== 'builder').map(([wallet]) => wallet).sort()
  return platform.slice(1).map(wallet => ({ a: platform[0], b: wallet, kind: 'platform', evidence: 'repo.ing wallet' }))
}

// links: [{ a, b, kind, evidence }] → { clusterOf, linked, evidence: Map clusterId → [{ kind, evidence }] }.
export function clusterWallets(wallets, links) {
  const clusters = createClusters()
  for (const wallet of wallets ?? []) if (wallet) clusters.add(wallet)
  for (const { a, b } of links ?? []) if (a && b && a !== b) clusters.link(a, b)
  const { clusterOf, linked } = clusters.snapshot()
  const evidence = new Map()
  for (const link of links ?? []) {
    if (!link?.a || !link?.b || link.a === link.b) continue
    const root = clusterOf.get(link.a)
    const list = evidence.get(root) ?? []
    if (list.length < 10) list.push({ kind: link.kind, evidence: link.evidence })
    evidence.set(root, list)
  }
  return { clusterOf, linked, evidence }
}

// Operator-recorded links touching any of the given wallets (removed links excluded). A database without migration 0071
// has none.
export async function readWalletLinks(db, wallets) {
  const list = [...new Set((wallets ?? []).filter(wallet => BASE58.test(wallet)))]
  if (!list.length) return []
  try {
    const { rows } = await db.query(`select wallet_a as a, wallet_b as b, evidence from wallet_links
      where removed_at is null and (wallet_a = any($1::text[]) or wallet_b = any($1::text[]))`, [list])
    return rows.map(row => ({ a: row.a, b: row.b, kind: 'operator', evidence: row.evidence }))
  } catch (error) {
    if (error?.code === '42P01') return []
    throw error
  }
}

// Canonical pair for an operator link: { walletA, walletB } with walletA < walletB, or an Error for invalid input.
export function walletLinkPair(first, second) {
  const a = String(first ?? '').trim(), b = String(second ?? '').trim()
  if (!BASE58.test(a) || !BASE58.test(b)) throw new Error('Both wallets must be base58 Solana addresses')
  if (a === b) throw new Error('A wallet cannot be linked to itself')
  return a < b ? { walletA: a, walletB: b } : { walletA: b, walletB: a }
}
