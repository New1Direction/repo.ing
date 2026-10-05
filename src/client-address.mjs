import { isIPv6 } from 'node:net'

// The address a request came from, for counting requests per visitor: Cloudflare's own header when it proxied the request,
// else the first forwarded address, else X-Real-IP, else null.
// - Not authentication: a request that reaches the origin without Cloudflare can claim any address.
// - Through Cloudflare the first X-Forwarded-For entry is whatever the client sent, so it is only the fallback.
// - An IPv6 visitor holds a whole /64, so its first four groups are the visitor. An IPv4 address written as IPv6 is that
//   IPv4 address. An address with no network part (::, ::1) is nobody: null.
export function clientAddress(request) {
  const headers = request.headers
  const address = headers.get('cf-connecting-ip')?.trim() || headers.get('x-forwarded-for')?.split(',')[0].trim() || headers.get('x-real-ip')?.trim()
  return address ? addressKey(address) : null
}

const dotted = (high, low) => [high >> 8, high & 255, low >> 8, low & 255].join('.')

function addressKey(address) {
  if (!isIPv6(address)) return address.slice(0, 64)
  // Eight 16-bit groups: a zone is dropped, a dotted IPv4 tail is two groups, and :: stands for the zero groups left out.
  const text = address.toLowerCase().split('%')[0]
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  const hex = tail ? `${text.slice(0, tail.index)}${((Number(tail[1]) << 8) | Number(tail[2])).toString(16)}:${((Number(tail[3]) << 8) | Number(tail[4])).toString(16)}` : text
  const [head, rest = ''] = hex.split('::')
  const left = head ? head.split(':') : [], right = rest ? rest.split(':') : []
  const [a, b, c, d, e, f, g, h] = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right].map(group => parseInt(group, 16) || 0)
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): the visitor is the IPv4 address inside.
  const mapped = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff
  const nat64 = a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0
  if (mapped || nat64) return dotted(g, h)
  if (a === 0 && b === 0 && c === 0 && d === 0) return null
  return `${[a, b, c, d].map(group => group.toString(16)).join(':')}::/64`
}
