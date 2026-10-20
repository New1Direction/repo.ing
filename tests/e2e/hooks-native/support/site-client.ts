// The site's own HTTP API driven from Node with a disposable wallet that REALLY signs (ed25519, @solana/web3.js Keypair):
// sign-in through the wallet-identity challenge, then native trades through the same review -> wallet-request -> sign ->
// retain-wallet -> submit -> reconcile lifecycle the trade panel runs. Used where a browser adds nothing: server-side
// refusals (requests the panel would never send) and filling a curve quickly. Every request is same-origin, as a browser's.
import { createPrivateKey, sign } from 'node:crypto'
import { Keypair, VersionedTransaction } from '@solana/web3.js'
import { estimateTrade, nativeTradeIntent } from '../../../../app/lib/hooklab-trade-math.mjs'
import { stack } from './stack.ts'

let visitors = 20_000 + Math.floor(Math.random() * 20_000)

export interface ApiReply { status: number; json: any }
export class SiteClient {
  readonly address: string
  private readonly cookies = new Map<string, string>()
  private readonly visitor: string
  constructor(readonly wallet: Keypair) {
    this.address = wallet.publicKey.toBase58()
    const n = visitors++
    this.visitor = `198.18.${(n >> 8) & 255}.${n & 255}`
  }
  async post(path: string, body: unknown): Promise<ApiReply> {
    const response = await fetch(new URL(path, stack.origin), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000), headers: {
      origin: stack.origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': this.visitor,
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, body: JSON.stringify(body) })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';'), at = pair.indexOf('='), name = pair.slice(0, at), value = pair.slice(at + 1)
      if (/max-age=0/i.test(line) || !value) this.cookies.delete(name); else this.cookies.set(name, value)
    }
    return { status: response.status, json: await response.json().catch(() => null) }
  }
  /** The wallet-identity sign-in: the server's challenge message, signed with the wallet's own key. */
  async signIn(): Promise<void> {
    const challenge = await this.post('/api/hook-lab/wallet-identity', { action: 'challenge', wallet: this.address })
    if (challenge.status !== 200) throw new Error(`challenge ${challenge.status} ${JSON.stringify(challenge.json)}`)
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(this.wallet.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' })
    const signature = sign(null, Buffer.from(challenge.json.challenge.message, 'utf8'), key).toString('base64')
    const verified = await this.post('/api/hook-lab/wallet-identity', { action: 'verify', wallet: this.address, nonce: challenge.json.challenge.nonce, signature })
    if (verified.status !== 200 || verified.json?.signedIn !== true) throw new Error(`verify ${verified.status} ${JSON.stringify(verified.json)}`)
  }
  /** Starts a native trade review exactly as the panel would (or with `override` fields, as a tampering client would). */
  async nativeQuote(market: any, side: 'buy' | 'sell', amount: bigint, { graduate = false, coinBalance = 0n, override = {} }: { graduate?: boolean; coinBalance?: bigint; override?: Record<string, unknown> } = {}): Promise<ApiReply & { signingId: string }> {
    const estimate = estimateTrade(market, { side, amount, coinBalance, slippageBps: 300 })
    const minAmountOut = estimate.error ? 1n : estimate.minAmountOut
    const signingId = crypto.randomUUID()
    const reply = await this.post('/api/hook-lab/inclusive-trade', { action: 'native-quote', signingId, request: { ...nativeTradeIntent(market, side, amount, minAmountOut, graduate), ...override } })
    return { ...reply, signingId }
  }
  /** Signs the reviewed bytes with the wallet key, then retain-wallet, submit and reconcile until final. */
  async signAndSettle(signingId: string): Promise<any> {
    const issued = await this.post('/api/hook-lab/inclusive-trade', { action: 'wallet-request', signingId })
    if (issued.status !== 200) throw new Error(`wallet-request ${issued.status} ${JSON.stringify(issued.json)}`)
    const tx = VersionedTransaction.deserialize(Buffer.from(issued.json.partialTransactionBase64, 'base64'))
    tx.sign([this.wallet])
    const retained = await this.post('/api/hook-lab/inclusive-trade', { action: 'retain-wallet', signingId, signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64') })
    if (retained.status !== 200) throw new Error(`retain-wallet ${retained.status} ${JSON.stringify(retained.json)}`)
    let op = (await this.post('/api/hook-lab/inclusive-trade', { action: 'submit', signingId })).json?.operation
    for (let i = 0; i < 60 && !['finalized-success', 'finalized-failure', 'review-required', 'expired'].includes(op?.status); i++) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      op = (await this.post('/api/hook-lab/inclusive-trade', { action: 'reconcile', signingId })).json?.operation
    }
    return op
  }
}
