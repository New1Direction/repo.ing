// Browser-only persistence. Resolve writes on transaction completion, not request success.
// CAS prevents a stale tab from replacing a newer encrypted journal or mint identity.
export async function openHookLabCustodyStore({ indexedDB = globalThis.indexedDB, name = 'repoing-hooklab-custody-v1' } = {}) {
  if (!indexedDB) throw new Error('IndexedDB is required; there is no volatile fallback')
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    let blocked = false
    request.onupgradeneeded = () => request.result.createObjectStore('vaults')
    request.onsuccess = () => blocked ? request.result.close() : resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => { blocked = true; reject(new Error('Close other custody tabs before upgrading storage')) }
  })
  db.onversionchange = () => db.close()
  function transact(mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('vaults', mode, { durability: 'strict' })
      let result
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(tx.error ?? new Error('Custody storage transaction aborted'))
      tx.onerror = () => {} // The abort handler owns failure; never acknowledge an uncommitted write.
      operation(tx.objectStore('vaults'), value => { result = value })
    })
  }
  return Object.freeze({
    listIds() {
      return transact('readonly', (store, done) => {
        const request = store.getAllKeys()
        request.onsuccess = () => done(request.result)
      })
    },
    load(id) {
      return transact('readonly', (store, done) => {
        const request = store.get(id)
        request.onsuccess = () => done(request.result ?? null)
      })
    },
    compareAndSwap(id, expected, next) {
      return transact('readwrite', (store, done) => {
        const request = store.get(id)
        request.onsuccess = () => {
          if ((request.result ?? null) !== expected) return done(false)
          store.put(next, id)
          done(true)
        }
      })
    },
    close() { db.close() },
  })
}
