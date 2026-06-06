const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const {
  buildManifest,
  assemblePages,
  publishToGhPages,
  buildCertData,
  renderCertData,
} = require('../publish')

test('buildManifest returns one abrp entry with the given version', () => {
  const m = buildManifest('9.9.9')
  assert.strictEqual(Array.isArray(m), true)
  assert.strictEqual(m.length, 1)
  const e = m[0]
  assert.strictEqual(e.name, 'abrp')
  assert.strictEqual(e.version, '9.9.9')
  assert.ok(e.prerequisites.includes('ovms>=3.3.004'))
  assert.deepStrictEqual(e.elements, [
    { type: 'module', path: 'abrp.js', name: 'abrp' },
    { type: 'module', path: 'certdata.js', name: 'abrp_certdata' },
  ])
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

function git(args, cwd) {
  return execFileSync('git', args, { cwd: cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

test('publishToGhPages creates then updates origin/gh-pages with the staged tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws2-ghp-'))
  const bare = path.join(root, 'origin.git')
  const work = path.join(root, 'work')

  git(['init', '--bare', '-b', 'main', bare], root)
  git(['clone', bare, work], root)
  git(['config', 'user.email', 't@example.com'], work)
  git(['config', 'user.name', 'Tester'], work)
  fs.writeFileSync(path.join(work, 'README.md'), 'x\n')
  git(['add', '-A'], work)
  git(['commit', '-m', 'init'], work)
  git(['push', 'origin', 'main'], work)

  const bundle = path.join(root, 'abrp.js')
  fs.writeFileSync(bundle, 'module.exports = {}\n')

  // create
  let stage = path.join(root, 'stage1')
  assemblePages(stage, bundle, '1.0.0')
  fs.writeFileSync(path.join(stage, 'stale.txt'), 'old\n')
  publishToGhPages(work, stage, 'release 1.0.0')

  let check = path.join(root, 'check1')
  git(['clone', '-b', 'gh-pages', bare, check], root)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(check, 'plugins.json'), 'utf8'))[0].version, '1.0.0')
  assert.ok(fs.existsSync(path.join(check, 'abrp', 'abrp.js')))
  assert.ok(fs.existsSync(path.join(check, 'stale.txt')))

  // update — staged without the sentinel; a clean-tree publish must drop it
  stage = path.join(root, 'stage2')
  assemblePages(stage, bundle, '2.0.0')
  publishToGhPages(work, stage, 'release 2.0.0')

  check = path.join(root, 'check2')
  git(['clone', '-b', 'gh-pages', bare, check], root)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(check, 'plugins.json'), 'utf8'))[0].version, '2.0.0')
  assert.ok(!fs.existsSync(path.join(check, 'stale.txt')))
})

test('buildCertData reads trustedca pem/crt files into {file,pem} entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-'))
  fs.writeFileSync(path.join(dir, 'root.crt'), 'PEM-ROOT\n')
  fs.writeFileSync(path.join(dir, 'amazon.pem'), 'PEM-AMAZON\n')
  fs.writeFileSync(path.join(dir, 'README.md'), 'ignore me\n')

  const entries = buildCertData(dir)
  assert.deepStrictEqual(entries, [
    { file: 'amazon.pem', pem: 'PEM-AMAZON\n' },
    { file: 'root.crt', pem: 'PEM-ROOT\n' },
  ])
})

test('buildCertData/renderCertData handle a dir with no cert files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-empty-'))
  fs.writeFileSync(path.join(dir, 'README.md'), 'no certs here\n')
  assert.deepStrictEqual(buildCertData(dir), [])

  const code = renderCertData([])
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-empty-')), 'certdata.js')
  fs.writeFileSync(out, code)
  delete require.cache[require.resolve(out)]
  assert.deepStrictEqual(require(out), [])
})

test('renderCertData emits a Duktape-safe module exporting the entries', () => {
  const entries = [{ file: 'a.crt', pem: 'L1\nL2\n' }]
  const code = renderCertData(entries)
  assert.ok(!/=>/.test(code)) // no arrow functions
  assert.ok(!/`/.test(code)) // no template literals

  // It must evaluate to the same array via require.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-')), 'certdata.js')
  fs.writeFileSync(out, code)
  delete require.cache[require.resolve(out)]
  assert.deepStrictEqual(require(out), entries)
})

test('assemblePages also writes abrp/certdata.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-cd-'))
  const bundle = path.join(dir, 'src-abrp.js')
  fs.writeFileSync(bundle, '// fake bundle\nmodule.exports = {}\n')
  const certDir = path.join(dir, 'certs')
  fs.mkdirSync(certDir)
  fs.writeFileSync(path.join(certDir, 'x.crt'), 'PEM-X\n')

  assemblePages(path.join(dir, 'out'), bundle, '9.9.9', certDir)

  const certdata = require(path.join(dir, 'out', 'abrp', 'certdata.js'))
  assert.deepStrictEqual(certdata, [{ file: 'x.crt', pem: 'PEM-X\n' }])
})
