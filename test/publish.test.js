const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildManifest, assemblePages } = require('../publish')

test('buildManifest returns one abrp entry with the given version', () => {
  const m = buildManifest('9.9.9')
  assert.strictEqual(Array.isArray(m), true)
  assert.strictEqual(m.length, 1)
  const e = m[0]
  assert.strictEqual(e.name, 'abrp')
  assert.strictEqual(e.version, '9.9.9')
  assert.ok(e.prerequisites.includes('ovms>=3.3.004'))
  assert.deepStrictEqual(e.elements, [{ type: 'module', path: 'abrp.js', name: 'abrp' }])
})

test('manifest version tracks constants.VERSION', () => {
  const C = require('../lib/abrp/constants')
  assert.strictEqual(buildManifest(C.VERSION)[0].version, C.VERSION)
})

test('assemblePages writes plugins.json + abrp/abrp.js with the bundle bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'))
  const bundle = path.join(dir, 'src-abrp.js')
  fs.writeFileSync(bundle, '// fake bundle\nmodule.exports = {}\n')
  assemblePages(path.join(dir, 'out'), bundle, '9.9.9')

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'plugins.json'), 'utf8'))
  assert.strictEqual(manifest[0].version, '9.9.9')
  const copied = fs.readFileSync(path.join(dir, 'out', 'abrp', 'abrp.js'), 'utf8')
  assert.strictEqual(copied, '// fake bundle\nmodule.exports = {}\n')
})
