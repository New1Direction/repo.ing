import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { githubImageVariant, githubImageVariantResponse, imageWidthParam } from '../src/token-image.mjs'
import { GET } from '../app/api/repo-logo/[repo]/route.js'

const imageResponse = bytes => new Response(bytes, { status: 200 })

test('logo width accepts only the avatar sizes; absent keeps the canonical redirect', () => {
  assert.equal(imageWidthParam(null), null)
  for (const width of [64, 128, 256]) assert.equal(imageWidthParam(String(width)), width)
  for (const bad of ['', '0', '100', '128.0', '0128', '1e2', ' 128', 'abc', '99999']) assert.equal(imageWidthParam(bad), undefined, bad)
})

test('repo-logo rejects a bad width before any database or GitHub work', async () => {
  const call = (repo, query) => GET(new Request(`http://local/api/repo-logo/${repo}${query}`), { params: Promise.resolve({ repo }) })
  assert.equal((await call('123', '?v=3&w=100')).status, 400)
  assert.equal((await call('123', '?v=3&w=')).status, 400)
  assert.equal((await call('abc', '?v=3&w=128')).status, 404)
})

test('remote logos become cached, aspect-preserving WebP renditions', async () => {
  const png = await sharp({ create: { width: 800, height: 400, channels: 4, background: '#3366cc' } }).png().toBuffer()
  const seen = []
  const fetchImpl = async url => { seen.push(url); return imageResponse(png) }
  const url = 'https://raw.githubusercontent.com/o/r/main/logo.png'
  const body = await githubImageVariant(url, 128, { fetchImpl, now: 1 })
  const meta = await sharp(body).metadata()
  assert.equal(meta.format, 'webp'); assert.equal(meta.width, 128); assert.equal(meta.height, 64)
  assert.equal(await githubImageVariant(url, 128, { fetchImpl, now: 2 }), body)
  assert.equal(seen.length, 1)
  await githubImageVariant(url, 128, { fetchImpl, now: 2 + 60 * 60_000 })
  assert.equal(seen.length, 2, 'logos can change, so renditions expire')
  const response = githubImageVariantResponse(body)
  assert.equal(response.headers.get('content-type'), 'image/webp')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=86400')
})

test('avatars are requested at the target size; SVG, foreign hosts and redirects off GitHub are refused', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).png().toBuffer()
  const seen = []
  await githubImageVariant('https://avatars.githubusercontent.com/u/1?v=4', 64, { fetchImpl: async url => { seen.push(url); return imageResponse(png) } })
  assert.equal(seen[0], 'https://avatars.githubusercontent.com/u/1?v=4&s=64')
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>')
  await assert.rejects(githubImageVariant('https://raw.githubusercontent.com/o/r/main/logo.svg', 64, { fetchImpl: async () => imageResponse(svg) }), /Unsupported image format/)
  await assert.rejects(githubImageVariant('https://example.com/logo.png', 64, { fetchImpl: async () => imageResponse(png) }), /Unsupported image source/)
  const redirect = async () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } })
  await assert.rejects(githubImageVariant('https://raw.githubusercontent.com/o/r/main/moved.png', 64, { fetchImpl: redirect }), /Unsupported image source/)
})
