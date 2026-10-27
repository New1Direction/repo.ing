// A connection that stops re-downloading unchanged ProgramData (owner 2026-10-27). Each Hooks preparation step re-read the
// launch, swap, gate and token ProgramData (~2 MB per provider, twice per step), which pushed review → submit past the
// 140-slot lease on a slower container. A ProgramData body read in full is kept in this process and served again only after
// a fresh read, at or after the rest of the snapshot, finds its 45-byte header (kind, deploy slot, upgrade authority), size,
// lamports, owner and executable flag unchanged: an upgrade, extension, close or authority change always re-reads in full.
// Callers get exactly what an uncached read returns; every check on those bytes still runs.
import { PublicKey } from '@solana/web3.js'

export const PROGRAM_DATA_HEADER = 45
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const isProgramData = account => !!account && account.owner.toBase58() === LOADER && account.data.length >= PROGRAM_DATA_HEADER
  && account.data.readUInt32LE(0) === 3
const sameHeader = (entry, header) => !!header && header.owner.toBase58() === LOADER && header.executable === entry.executable
  && header.lamports === entry.lamports && header.space === entry.space && header.data.length === PROGRAM_DATA_HEADER
  && header.data.equals(entry.data.subarray(0, PROGRAM_DATA_HEADER))
const configOf = config => typeof config === 'string' ? { commitment: config } : { ...(config ?? {}) }

export function programDataCachedConnection(connection) {
  const cache = new Map()
  const remember = (keys, value) => value.forEach((account, i) => {
    const address = keys[i].toBase58()
    if (isProgramData(account)) cache.set(address, { data: Buffer.from(account.data), lamports: account.lamports,
      executable: account.executable, space: account.space ?? account.data.length })
    else cache.delete(address)
  })
  async function full(keys, config) {
    const result = await connection.getMultipleAccountsInfoAndContext(keys, config)
    remember(keys, result.value)
    return result
  }
  async function getMultipleAccountsInfoAndContext(publicKeys, commitmentOrConfig) {
    const config = configOf(commitmentOrConfig), keys = publicKeys.map(k => new PublicKey(k))
    if (config.dataSlice || (config.encoding && config.encoding !== 'base64')) return connection.getMultipleAccountsInfoAndContext(publicKeys, commitmentOrConfig)
    const cachedAt = keys.map((k, i) => cache.has(k.toBase58()) ? i : -1).filter(i => i >= 0)
    if (cachedAt.length === 0) return full(keys, config)
    const restAt = keys.map((_, i) => i).filter(i => !cachedAt.includes(i))
    const rest = restAt.length ? await connection.getMultipleAccountsInfoAndContext(restAt.map(i => keys[i]), config) : null
    const minContextSlot = rest ? Math.max(rest.context.slot, config.minContextSlot ?? 0) : config.minContextSlot
    const headers = await connection.getMultipleAccountsInfoAndContext(cachedAt.map(i => keys[i]),
      { ...config, ...(minContextSlot === undefined ? {} : { minContextSlot }), dataSlice: { offset: 0, length: PROGRAM_DATA_HEADER } })
    if (headers.value.length !== cachedAt.length || (rest && rest.value.length !== restAt.length)) return full(keys, config)
    const entries = cachedAt.map(i => cache.get(keys[i].toBase58()))
    if (!headers.value.every((header, j) => entries[j] && sameHeader(entries[j], header))) return full(keys, config)
    const value = new Array(keys.length)
    cachedAt.forEach((i, j) => { value[i] = { ...headers.value[j], data: Buffer.from(entries[j].data) } })
    restAt.forEach((i, j) => { value[i] = rest.value[j] })
    if (rest) remember(restAt.map(i => keys[i]), rest.value)
    return { context: rest ? rest.context : headers.context, value }
  }
  return new Proxy(connection, { get(target, property, receiver) {
    if (property === 'getMultipleAccountsInfoAndContext') return getMultipleAccountsInfoAndContext
    if (property === 'getMultipleAccountsInfo') return async (keys, config) => (await getMultipleAccountsInfoAndContext(keys, config)).value
    const value = Reflect.get(target, property, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
