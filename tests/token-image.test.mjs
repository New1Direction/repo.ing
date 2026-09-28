import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { fetchGithubImage, normalizeTokenImage, readLimitedBody, tokenImageBytes, tokenImageResponse, validateTokenImage } from '../src/token-image.mjs'
import { repositoryImagesFromReadme, safeGithubImageUrl } from '../src/repo-logo.mjs'

test('wide logos are fitted, not cropped, into a static square PNG', async () => {
  const original = await sharp({ create: { width: 480, height: 120, channels: 4, background: '#e04040' } }).png().toBuffer()
  const { image } = await normalizeTokenImage(original)
  const meta = await sharp(tokenImageBytes(image)).metadata()
  assert.equal(meta.width, 512); assert.equal(meta.height, 512); assert.equal(meta.format, 'png')
  const { data, info } = await sharp(tokenImageBytes(image)).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([...data.subarray(0, 3)], [255, 255, 255])
  const center = (256 * 512 + 256) * info.channels
  assert.deepEqual([...data.subarray(center, center + 3)], [224, 64, 64])
  assert.ok(await validateTokenImage(image))
})

test('white transparent logos get a dark canvas; empty images fail', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><circle cx="64" cy="64" r="32" fill="white"/></svg>'
  const { image } = await normalizeTokenImage(Buffer.from(svg), { allowSvg: true })
  const bytes = tokenImageBytes(image)
  const { data } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([...data.subarray(0, 3)], [22, 27, 34])
  const empty = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#00000000' } }).png().toBuffer()
  await assert.rejects(normalizeTokenImage(empty), /transparent/)
  await assert.rejects(normalizeTokenImage(Buffer.from(svg)), /PNG/)
})

test('bad, excessive, tiny, and externally referenced images are rejected', async () => {
  await assert.rejects(normalizeTokenImage(Buffer.from('<script>alert(1)</script>')), /could not be read/)
  await assert.rejects(normalizeTokenImage(Buffer.alloc(2 * 1024 * 1024 + 1)), /2 MB/)
  const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer()
  await assert.rejects(normalizeTokenImage(tiny), /32/)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><image href="http://127.0.0.1/secret" width="128" height="128"/></svg>'
  await assert.rejects(normalizeTokenImage(Buffer.from(svg), { allowSvg: true }), /references/)
  for (const image of ['https://evil.test/logo.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,bad']) {
    await assert.rejects(validateTokenImage(image))
  }
})

test('image downloads and redirects stay on HTTPS GitHub image hosts', async () => {
  for (const url of ['http://raw.githubusercontent.com/logo.png', 'https://raw.githubusercontent.com:8080/x',
    'https://user:pass@raw.githubusercontent.com/x', 'https://raw.githubusercontent.com.evil.test/x']) assert.equal(safeGithubImageUrl(url), null)
  let calls = 0
  await assert.rejects(fetchGithubImage('https://raw.githubusercontent.com/a/b/main/logo.png', async (_url, options) => {
    calls++; assert.equal(options.redirect, 'manual'); assert.equal(options.headers, undefined)
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
  }), /Unsupported/)
  assert.equal(calls, 1)
  await assert.rejects(readLimitedBody(new Response(new Uint8Array(200)), 100), /too large/)
})

test('suggestions are deduplicated and exclude badges, screenshots and sponsor artwork', () => {
  const markdown = '![logo](./logo.png) ![logo](./logo.png) ![mascot](./mascot.svg) ![sponsor logo](./sponsor.png) ![demo](./demo.png)'
  const images = repositoryImagesFromReadme(markdown, 'https://raw.githubusercontent.com/a/b/main/README.md', 'b')
  assert.equal(images.length, 2)
  assert.match(images[0].url, /logo.png$/)
})

test('served image bytes match saved artwork with immutable PNG headers', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).png().toBuffer()
  const { image } = await normalizeTokenImage(png)
  const saved = await validateTokenImage(image)
  const response = await tokenImageResponse(saved)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.match(response.headers.get('cache-control'), /immutable/)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), tokenImageBytes(saved))
})

test('avatar widths serve small immutable WebP renditions; other widths keep the canonical PNG', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'red' } }).png().toBuffer()
  const saved = await validateTokenImage((await normalizeTokenImage(png)).image)
  const canonical = await tokenImageResponse(saved)
  const small = await tokenImageResponse(saved, 128)
  assert.equal(small.headers.get('content-type'), 'image/webp')
  assert.match(small.headers.get('cache-control'), /immutable/)
  assert.notEqual(small.headers.get('etag'), canonical.headers.get('etag'))
  const meta = await sharp(Buffer.from(await small.arrayBuffer())).metadata()
  assert.equal(meta.format, 'webp'); assert.equal(meta.width, 128); assert.equal(meta.height, 128)
  const unsupported = await tokenImageResponse(saved, 100)
  assert.equal(unsupported.headers.get('content-type'), 'image/png')
})
