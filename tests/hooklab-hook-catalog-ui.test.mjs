import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { taxHookSetupManifest } from '../src/hooklab-hook-catalog.mjs'

const compiled = await build({ entryPoints: ['app/components/hooklab-hook-catalog.jsx'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic' })
const mod = { exports: {} }
Function('require','module','exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports)
const { HookCatalogSelector, HookCatalogPublisher } = mod.exports
const program = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8'
test('creator configuration renders typed fields, retained values, warnings and labelled advanced metadata', () => {
  const manifest = taxHookSetupManifest({ program, flags: 65 })
  const html = renderToStaticMarkup(createElement(HookCatalogSelector, { form: { selectedHook: manifest.selectedHook, hookPublication: { digest: 'a'.repeat(64), manifest, configuration: { feeBps: '125', maxWalletBps: '500', collector: program } } }, set() {}, disabled: true }))
  const doc = new JSDOM(html).window.document
  for (const field of ['feeBps','maxWalletBps','collector']) assert.ok(doc.querySelector(`label[for="hook-config-${field}"]`))
  assert.equal(doc.querySelector('#hook-config-feeBps').value, '125')
  assert.equal(doc.querySelector('#hook-config-feeBps').getAttribute('aria-label'), 'Transfer fee (basis points)')
  const bounds = doc.getElementById(doc.querySelector('#hook-config-feeBps').getAttribute('aria-describedby'))
  assert.match(bounds?.textContent ?? '', /Allowed: 0–2000/)
  assert.ok(doc.querySelector('#hook-config-feeBps').closest('fieldset').disabled)
  assert.equal(doc.querySelector('a').getAttribute('href'), '/hooks/publish')
  assert.match(doc.body.textContent, /not endorsements/)
  assert.match(doc.body.textContent, /Server compatibility checks still apply/)
  assert.ok(doc.querySelector('label[for="hook-program"]'))
})
test('publisher renders wallet attribution, append-only warning and explicit declaration inputs', () => {
  const doc = new JSDOM(renderToStaticMarkup(createElement(HookCatalogPublisher))).window.document
  for (const field of ['name','version','program','flags','behavior','fees','risks','manifest']) {
    assert.ok(doc.querySelector(`label[for="publish-${field}"]`)); assert.ok(doc.querySelector(`#publish-${field}`).required)
  }
  assert.match(doc.body.textContent, /append-only/)
  assert.match(doc.body.textContent, /collector holding is created atomically with the mint/)
  assert.equal(doc.querySelector('button[type="submit"]').textContent, 'Publish immutable version')
})
