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

test('buildManifest returns abrp + abrpweb + abrpcerts; abrp is shim + core', () => {
  const m = buildManifest('9.9.9')
  assert.strictEqual(Array.isArray(m), true)
  assert.strictEqual(m.length, 3)
  const byName = {}
  m.forEach((p) => {
    byName[p.name] = p
    assert.ok(/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.name)) // valid JS identifier (module global)
  })

  // abrp: a thin shim (module) + the real bundle shipped as data (webrsc). The
  // shim defers compiling abrp-core to a ticker so the big compile runs from the
  // shallow event-loop stack, not the deep plugin loader (DukTape stack overflow).
  assert.strictEqual(byName.abrp.version, '9.9.9')
  assert.deepStrictEqual(byName.abrp.elements, [
    { type: 'module', path: 'abrp.js', name: 'abrp' },
    { type: 'webrsc', path: 'abrp-core.js', name: 'abrp_core' },
  ])

  // abrpweb: the module backend + the three pages
  assert.deepStrictEqual(byName.abrpweb.elements, [
    { type: 'module', path: 'abrpweb.js', name: 'abrpweb' },
    { type: 'webpage', path: 'config.htm', name: 'abrpweb_config', label: 'ABRP Config', menu: 'Config', auth: 'admin', page: '/usr/abrp/config' },
    { type: 'webpage', path: 'dashboard.htm', name: 'abrpweb_status', label: 'ABRP Status', menu: 'Vehicle', auth: 'none', page: '/usr/abrp/status' },
    { type: 'webhook', path: 'status-hook.htm', name: 'abrpweb_status_hook', page: 'status', hook: 'body.post' },
  ])

  // abrpcerts: installer + cert data
  assert.deepStrictEqual(byName.abrpcerts.elements, [
    { type: 'module', path: 'abrpcerts.js', name: 'abrpcerts' },
    { type: 'webrsc', path: 'certdata.js', name: 'abrpcerts_certdata' },
  ])
})

test('manifest version tracks constants.VERSION', () => {
  const C = require('../lib/abrp/constants')
  assert.strictEqual(buildManifest(C.VERSION)[0].version, C.VERSION)
})

test('assemblePages writes plugins.json + abrp/abrp-core.js with the bundle bytes (abrp.js is the shim)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'))
  const bundle = path.join(dir, 'src-abrp.js')
  fs.writeFileSync(bundle, '// fake bundle\nmodule.exports = {}\n')
  assemblePages(path.join(dir, 'out'), bundle, '9.9.9')

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'plugins.json'), 'utf8'))
  assert.strictEqual(manifest[0].version, '9.9.9')
  // The bundle bytes ship as the abrp-core webrsc, NOT as the module element.
  const core = fs.readFileSync(path.join(dir, 'out', 'abrp', 'abrp-core.js'), 'utf8')
  assert.strictEqual(core, '// fake bundle\nmodule.exports = {}\n')
  // The module element (abrp.js) is the shim from the repo — it must NOT be the
  // bundle, and it must defer the real load to a ticker.
  const shim = fs.readFileSync(path.join(dir, 'out', 'abrp', 'abrp.js'), 'utf8')
  assert.notStrictEqual(shim, core)
  assert.match(shim, /ticker\.1/)
  assert.match(shim, /abrp-core/)
})

test('assemblePages writes plugins.rev so OVMS detects repo changes', () => {
  // Without plugins.rev the on-device pluginstore can't tell the repo changed and
  // refuses to refresh (Stage-2 blocker). It's a single revision string; we use
  // the plugin version so it advances on every release.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-rev-'))
  const bundle = path.join(dir, 'src-abrp.js')
  fs.writeFileSync(bundle, '// fake bundle\n')
  assemblePages(path.join(dir, 'out'), bundle, '9.9.9')

  const rev = fs.readFileSync(path.join(dir, 'out', 'plugins.rev'), 'utf8')
  assert.strictEqual(rev.trim(), '9.9.9')
})

test('assemblePages writes abrp/abrp.json as the single plugin manifest entry', () => {
  // OVMS fetches <base>/<name>/<name>.json on install and expects the single
  // plugin object (NOT the plugins.json array). Its absence made OVMS save the
  // 404 HTML and fail with "could not parse metadata" (Stage-2 crash lead-up).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-pj-'))
  const bundle = path.join(dir, 'src-abrp.js')
  fs.writeFileSync(bundle, '// fake bundle\n')
  assemblePages(path.join(dir, 'out'), bundle, '9.9.9')

  const perPlugin = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'abrp', 'abrp.json'), 'utf8'))
  assert.deepStrictEqual(perPlugin, buildManifest('9.9.9')[0])
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

test('certdata element (in abrpcerts) is a webrsc, not a module (avoids clobbering its global)', () => {
  const certs = buildManifest('9.9.9').find((p) => p.name === 'abrpcerts')
  const cd = certs.elements.find((e) => e.path === 'certdata.js')
  assert.ok(cd)
  assert.notStrictEqual(cd.type, 'module')
})

test('assemblePages writes the abrpcerts plugin (installer module + certdata), not under abrp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-cd-'))
  const bundle = path.join(dir, 'src-abrp.js')
  fs.writeFileSync(bundle, '// fake bundle\nmodule.exports = {}\n')
  const certDir = path.join(dir, 'certs')
  fs.mkdirSync(certDir)
  fs.writeFileSync(path.join(certDir, 'x.crt'), 'PEM-X\n')
  const certsPlugin = path.join(dir, 'src-abrpcerts.js')
  fs.writeFileSync(certsPlugin, '// fake installer\nmodule.exports = {}\n')

  assemblePages(path.join(dir, 'out'), bundle, '9.9.9', certDir, undefined, certsPlugin)

  // cert data now lives under the abrpcerts plugin
  const certdata = require(path.join(dir, 'out', 'abrpcerts', 'certdata.js'))
  assert.deepStrictEqual(certdata, [{ file: 'x.crt', pem: 'PEM-X\n' }])
  // installer module element shipped
  assert.strictEqual(
    fs.readFileSync(path.join(dir, 'out', 'abrpcerts', 'abrpcerts.js'), 'utf8'),
    '// fake installer\nmodule.exports = {}\n'
  )
  // per-plugin manifest present
  assert.ok(fs.existsSync(path.join(dir, 'out', 'abrpcerts', 'abrpcerts.json')))
  // and abrp no longer has certdata
  assert.ok(!fs.existsSync(path.join(dir, 'out', 'abrp', 'certdata.js')))
})

test('the abrpweb page/hook elements are never module (avoids clobbering the abrpweb global)', () => {
  const web = buildManifest('9.9.9').find((p) => p.name === 'abrpweb')
  web.elements.filter((e) => /\.htm$/.test(e.path)).forEach((e) => {
    assert.notStrictEqual(e.type, 'module')
  })
})

test('assemblePages copies the web/*.htm assets into abrpweb/, not abrp/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-web-'))
  const bundle = path.join(dir, 'src-abrp.js')
  fs.writeFileSync(bundle, '// fake bundle\nmodule.exports = {}\n')
  const certDir = path.join(dir, 'certs'); fs.mkdirSync(certDir)
  fs.writeFileSync(path.join(certDir, 'x.crt'), 'PEM-X\n')
  const webDir = path.join(dir, 'web'); fs.mkdirSync(webDir)
  fs.writeFileSync(path.join(webDir, 'config.htm'), '<i>config</i>\n')
  fs.writeFileSync(path.join(webDir, 'dashboard.htm'), '<i>dash</i>\n')
  fs.writeFileSync(path.join(webDir, 'status-hook.htm'), '<i>hook</i>\n')
  const webPlugin = path.join(dir, 'src-abrpweb.js')
  fs.writeFileSync(webPlugin, '// fake web backend\nmodule.exports = {}\n')

  assemblePages(path.join(dir, 'out'), bundle, '9.9.9', certDir, webDir, undefined, webPlugin)

  const outWeb = path.join(dir, 'out', 'abrpweb')
  assert.ok(fs.existsSync(path.join(outWeb, 'abrpweb.js')))
  assert.ok(fs.existsSync(path.join(outWeb, 'config.htm')))
  assert.ok(fs.existsSync(path.join(outWeb, 'dashboard.htm')))
  assert.ok(fs.existsSync(path.join(outWeb, 'status-hook.htm')))
  // pages no longer under abrp/
  assert.ok(!fs.existsSync(path.join(dir, 'out', 'abrp', 'config.htm')))
})
