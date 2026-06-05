// OVMS plugin packaging: generate the manifest + assemble the gh-pages repo tree.
// Node-side build tooling (NOT bundled to Duktape). Usage:
//   node publish.js --out <dir>     # assemble plugins.json + abrp/abrp.js into <dir>
//   node publish.js --publish       # build gh-pages and push to origin/gh-pages
var fs = require('fs')
var path = require('path')
var os = require('os')
var childProcess = require('child_process')

function arg(name, def) {
  var i = process.argv.indexOf('--' + name)
  return i !== -1 ? process.argv[i + 1] : def
}

// Builds the plugins.json array (a single abrp plugin entry) for the given version.
function buildManifest(version) {
  return [
    {
      name: 'abrp',
      title: 'A Better Routeplanner (ABRP) Live Telemetry',
      version: version,
      maintainer: 'Jerry Kezar <kezarjg@gmail.com>',
      info: 'https://github.com/kezarjg/ovms-link',
      group: 'Electric Vehicles',
      description: 'Streams live EV telemetry to ABRP via the Iternio Telemetry API.',
      prerequisites: ['ovms>=3.3.004'],
      elements: [{ type: 'module', path: 'abrp.js', name: 'abrp' }],
    },
  ]
}

// Writes the Pages tree into outDir: plugins.json (the manifest) and abrp/abrp.js
// (a copy of the bundle at bundlePath). Returns the written paths.
function assemblePages(outDir, bundlePath, version) {
  var pluginDir = path.join(outDir, 'abrp')
  var manifestPath = path.join(outDir, 'plugins.json')
  var moduleOut = path.join(pluginDir, 'abrp.js')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(manifestPath, JSON.stringify(buildManifest(version), null, 2) + '\n')
  fs.copyFileSync(bundlePath, moduleOut)
  return { manifestPath: manifestPath, moduleOut: moduleOut }
}

function run(args, cwd) {
  return childProcess.execFileSync('git', args, { cwd: cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

function remoteHasGhPages(repoDir) {
  try {
    run(['ls-remote', '--exit-code', 'origin', 'gh-pages'], repoDir)
    return true
  } catch (e) {
    return false
  }
}

// Publishes the contents of stageDir to origin/gh-pages of repoDir, using a
// temporary git worktree so the main working tree is never disturbed. Creates
// the gh-pages branch (orphan) on first run; replaces its contents on later runs.
function publishToGhPages(repoDir, stageDir, message) {
  var base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghpages-'))
  var wt = path.join(base, 'wt')
  try {
    if (remoteHasGhPages(repoDir)) {
      run(['fetch', 'origin', 'gh-pages'], repoDir)
      run(['worktree', 'add', '-B', 'gh-pages', wt, 'origin/gh-pages'], repoDir)
    } else {
      run(['worktree', 'add', '--detach', wt], repoDir)
      run(['checkout', '--orphan', 'gh-pages'], wt)
    }
    // Start from a clean tree, then lay down the staged files.
    try { run(['rm', '-rf', '.'], wt) } catch (e) { /* empty orphan: nothing to remove */ }
    fs.cpSync(stageDir, wt, { recursive: true })
    run(['add', '-A'], wt)
    run(['commit', '-m', message], wt)
    run(['push', 'origin', 'gh-pages'], wt)
  } finally {
    try { run(['worktree', 'remove', '--force', wt], repoDir) } catch (e) { /* best effort */ }
    try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  }
}

module.exports = { buildManifest: buildManifest, assemblePages: assemblePages, publishToGhPages: publishToGhPages }

// --- CLI ---
if (require.main === module) {
  var C = require('./lib/abrp/constants')
  var out = arg('out', null)
  var doPublish = process.argv.indexOf('--publish') !== -1
  var bundle = path.resolve(__dirname, 'dist/abrp.js')
  if ((doPublish || out) && !fs.existsSync(bundle)) {
    console.error('publish.js: ' + bundle + ' not found — run `npm run build` first')
    process.exit(1)
  }
  if (doPublish) {
    var stage = fs.mkdtempSync(path.join(os.tmpdir(), 'abrp-pages-'))
    assemblePages(stage, bundle, C.VERSION)
    publishToGhPages(process.cwd(), stage, 'release: abrp ' + C.VERSION + ' plugin repo')
    console.log('publish.js: published abrp ' + C.VERSION + ' to origin/gh-pages')
  } else if (out) {
    var res = assemblePages(out, bundle, C.VERSION)
    console.log('publish.js: wrote ' + res.manifestPath + ' and ' + res.moduleOut + ' (version ' + C.VERSION + ')')
  } else {
    console.error('publish.js: expected --out <dir> or --publish')
    process.exit(1)
  }
}
