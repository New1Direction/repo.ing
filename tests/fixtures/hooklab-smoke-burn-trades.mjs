// The Burn mainnet smoke test coin $SMKBRN (mint 3k7Urc6AbJhgkpT5PGyMzYPDUp5eB4uCckm8NmvYqaDc, launched 2026-10-27):
// its market terms, its pool as launched, the six finalized swaps (amounts from the swap events, burns from the mint's
// supply drop, creator fees from the recorded quote_fee) and the pool account read on mainnet after them (2026-10-28).
export const SMOKE_MARKET = Object.freeze({
  mint: '3k7Urc6AbJhgkpT5PGyMzYPDUp5eB4uCckm8NmvYqaDc', symbol: 'SMKBRN', decimals: 6, native: true, graduated: false, policyKind: null,
  feeModel: 2, protocolShareBps: 2500, lpFeeBps: 0, creatorFeeBps: 200, burnBuyBps: 300, burnSellBps: 300, capBps: 100,
  initialSupply: '1000000000000000', capRaw: '10000000000000', graduationQuote: '111182487524',
})
export const SMOKE_START_POOL = Object.freeze({
  baseReserve: 750000000000000n, quoteReserve: 0n, virtualBase: 375000000000000n, virtualQuote: 55591243762n, protocolFeesQuote: 0n,
})
export const SMOKE_TRADES = Object.freeze([
  { signature: '46js9CqNzgd1XpGykWh1MYasuynT9h9wPBoNkHrkGard3oapVcZnGNvPSNJ9LgHeGQ2k6ovjZReSweCzjxWAMVRK', side: 'buy', solLamports: '4000000', tokenBaseUnits: '76943743134', burned: '2379703395', creatorFee: '80000' },
  { signature: '3bcHiRXPZhXemaLPWKYDVSRm3SVPzQHyb8J7GgEMSpe2ViJgzd8o5kxsZmyLZhjwud12yaXgLFeT1ctTtud4MdtZ', side: 'sell', solLamports: '3614576', tokenBaseUnits: '76943743134', burned: '2308312294', creatorFee: '73767' },
  { signature: '3qMPc8fhAVdWL6QfgE4XZyj13PQfTQdUhNYtvG3NYo2CrGbhTrZQXyT5Ug3oYK3aW8h3ZXFjexurPrGo7cMG5aGs', side: 'buy', solLamports: '12000000', tokenBaseUnits: '230796758969', burned: '7138044091', creatorFee: '240000' },
  { signature: '31mxDccU6StnPn6v4HdoyjRG8ynCC28vxRVBdjSA4G3nVoH6rNk15yTpyFdkWV7wraM6BbVMe4gtKMTJgv4EXyET', side: 'sell', solLamports: '10843819', tokenBaseUnits: '230796758969', burned: '6923902769', creatorFee: '221303' },
  { signature: '3VhqyL5TGug8Sapj9CwrwjAHkpaXeRztjK6FdpLqw16Ep5nApJqWq6knnnCURcw2Y9C9AZqw5PK2An53ciVQYAYu', side: 'buy', solLamports: '1000000', tokenBaseUnits: '19236311858', burned: '594937480', creatorFee: '20000' },
  { signature: '4c1wXjX8Pbh1qKpS9Z3uNEJouKsU4qUDC5cZMap2QTMdL48CYjj3SZ2wSQt6YcsCp8HQonf9uS2y1rtEkuxAXY3H', side: 'sell', solLamports: '903640', tokenBaseUnits: '19236311858', burned: '577089355', creatorFee: '18442' },
])
export const SMOKE_FINAL_POOL = Object.freeze({ baseReserve: '749980078010616', quoteReserve: '984453', protocolFeesQuote: '163376' })
