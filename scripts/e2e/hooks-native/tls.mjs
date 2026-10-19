// A throwaway self-signed certificate for https://localhost and https://127.0.0.1 (the site and both RPC proxies), plus
// its SPKI hash: the test browser pins exactly this key (--ignore-certificate-errors-spki-list), and Node trusts it
// through NODE_EXTRA_CA_CERTS. Nothing is added to the macOS Keychain or any system trust store.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, X509Certificate } from 'node:crypto'

export function makeLocalCertificate(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const key = path.join(dir, 'local-key.pem'), cert = path.join(dir, 'local-cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: ['ignore', 'ignore', 'pipe'] })
  const x509 = new X509Certificate(readFileSync(cert))
  const spki = createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  return { key, cert, spki }
}
