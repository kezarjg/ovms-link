// OVMS plugin packaging: generate the manifest + assemble the gh-pages repo tree.
// Node-side build tooling (NOT bundled to Duktape). Usage:
//   node publish.js --out <dir>     # assemble plugins.json + abrp/abrp.js into <dir>
var fs = require('fs')
var path = require('path')

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

module.exports = { buildManifest: buildManifest, assemblePages: assemblePages }

// --- CLI ---
if (require.main === module) {
  var C = require('./lib/abrp/constants')
  var out = arg('out', null)
  if (out) {
    var res = assemblePages(out, 'dist/abrp.js', C.VERSION)
    console.log('publish.js: wrote ' + res.manifestPath + ' and ' + res.moduleOut + ' (version ' + C.VERSION + ')')
  } else {
    console.error('publish.js: nothing to do (expected --out <dir>)')
    process.exit(1)
  }
}
