import bs58 from 'bs58'
import BN from 'bn.js'

// The DBC swap events of a captured transaction (a raw fixture, as the RPC returns it) decoded, changed and re-encoded with the
// program's own coder, so the bytes are exactly what the program would emit. Returns a copy, under `signature` when given.
const EVENT_CPI = 'e445a52e51cb9a1d'
export function withSwapEvents(raw, program, change, signature = raw.transaction.signatures[0]) {
  const copy = structuredClone(raw)
  copy.transaction.signatures[0] = signature
  for (const group of copy.meta.innerInstructions) for (const instruction of group.instructions) {
    const bytes = Buffer.from(bs58.decode(instruction.data))
    if (bytes.subarray(0, 8).toString('hex') !== EVENT_CPI) continue
    const decoded = program.coder.events.decode(bytes.subarray(8).toString('base64'))
    if (decoded?.name !== 'evtSwap' && decoded?.name !== 'evtSwap2') continue
    change(decoded.name, decoded.data)
    const discriminator = Buffer.from(program.idl.events.find(event => event.name === decoded.name).discriminator)
    instruction.data = bs58.encode(Buffer.concat([bytes.subarray(0, 8), discriminator, program.coder.types.encode(decoded.name, decoded.data)]))
  }
  return copy
}

// The dust swaps mainnet's DBC program accepts on a stock curve, 1 raw unit in, as the stock-pair validator reported them
// (tests/stock-graduation-chain.test.mjs): a buy's trading fee, rounded up, takes its whole input, so nothing reaches the curve
// and nothing comes out; a sell's stock out rounds down to nothing, and so does its fee.
const DUST = {
  buy: { included: 1, excluded: 0, output: 0, tradingFee: 1 },
  sell: { included: 1, excluded: 1, output: 0, tradingFee: 0 },
}
// direction: 'buy' or 'sell', made from the captured swap of that direction (fixtures/dbc-stock-swaps-local.json).
export function dustSwap(raw, program, direction, signature) {
  const { included, excluded, output, tradingFee } = DUST[direction]
  return withSwapEvents(raw, program, (name, data) => {
    if (data.tradeDirection !== (direction === 'buy' ? 1 : 0)) throw Error(`The captured swap is not a ${direction}`)
    Object.assign(data.swapResult, { outputAmount: new BN(output), tradingFee: new BN(tradingFee), protocolFee: new BN(0), referralFee: new BN(0) })
    if (name === 'evtSwap') {
      Object.assign(data.swapResult, { actualInputAmount: new BN(excluded) })
      Object.assign(data.params, { amountIn: new BN(included), minimumAmountOut: new BN(0) })
      data.amountIn = new BN(included)
    } else {
      Object.assign(data.swapResult, { includedFeeInputAmount: new BN(included), excludedFeeInputAmount: new BN(excluded), amountLeft: new BN(0) })
      Object.assign(data.swapParameters, { amount0: new BN(included), amount1: new BN(0) })
    }
  }, signature)
}
