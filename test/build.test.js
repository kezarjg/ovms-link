const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// bundleDir(entryDir, entryName) bundles a directory of CommonJS modules into a
// single string and returns module.exports of the entry after evaluating it.
function buildAndLoad(srcDir, entry, out) {
  execSync(
    'node ' + path.resolve('build.js') + ' --src ' + srcDir + ' --entry ' + entry + ' --out ' + out
  )
  const code = fs.readFileSync(out, 'utf8')
  // Duktape-safety guard: no arrow functions / template literals in emitted code.
  expect(code).not.toMatch(/=>/)
  expect(code).not.toMatch(/`/)
  // Load the generated bundle the same way Jest/OVMS do — require(), not
  // new Function() (avoids the code-injection footgun; the bundle is our own
  // output but require is safer and more representative).
  delete require.cache[require.resolve(out)]
  return require(out)
}

test('bundles relative requires into a single self-contained module', () => {
  const dir = path.resolve('test/fixtures/bundle')
  // NOTE: keep `out` OUTSIDE the --src dir, or the bundler would read it back in.
  const out = path.resolve('test/fixtures/bundle.out.js')
  const api = buildAndLoad(dir, 'entry', out)
  expect(api.greet('world')).toBe('hello, world')
  fs.unlinkSync(out)
})
