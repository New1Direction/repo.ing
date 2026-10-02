// Module hooks that let node --test import the app's .jsx components (render-jsx.mjs registers them): extensionless
// relative imports resolve the way Next resolves them, JSX compiles with esbuild (a drizzle-kit dependency), and
// stylesheet imports become empty modules.
import { transform } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const EXTENSIONS = ['.jsx', '.js', '.mjs']

export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (error) {
    if (/\.(?:[cm]?jsx?|css)$/.test(specifier)) throw error
    // next/link, next/navigation…: CommonJS entry files without an exports map.
    if (/^next\/[\w/-]+$/.test(specifier)) return next(`${specifier}.js`, context)
    if (!/^\.{1,2}\//.test(specifier)) throw error
    for (const extension of EXTENSIONS) {
      try { return await next(specifier + extension, context) } catch { /* try the next extension */ }
    }
    throw error
  }
}

export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
  if (url.startsWith('file:') && (url.endsWith('.jsx') || (url.includes('/app/') && url.endsWith('.js')))) {
    const file = fileURLToPath(url)
    const { code } = await transform(await readFile(file, 'utf8'), { loader: 'jsx', jsx: 'automatic', format: 'esm', sourcefile: file })
    return { format: 'module', source: code, shortCircuit: true }
  }
  return next(url, context)
}
