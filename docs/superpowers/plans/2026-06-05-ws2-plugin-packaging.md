# WS2 Plugin Packaging + gh-pages Distribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the bundled `dist/abrp.js` as an installable OVMS plugin — generate the manifest + repo index, publish them to a `gh-pages` branch, and document the `plugin install abrp` flow (hand-copy kept as fallback; cert step stays manual).

**Architecture:** A Node-side `publish.js` (sibling of `build.js`) exposes two pure, unit-tested functions — `buildManifest(version)` (the `plugins.json` array) and `assemblePages(outDir, bundlePath, version)` (writes `plugins.json` + `abrp/abrp.js`) — plus `publishToGhPages(repoDir, stageDir, message)` (git-worktree push to `gh-pages`) and a CLI. `npm run release` builds, assembles, and publishes. Spec: `docs/superpowers/specs/2026-06-05-ws2-plugin-packaging-design.md`.

**Tech Stack:** Node 22 (build tooling — NOT Duktape, so modern JS is allowed, but `publish.js` follows `build.js`'s `var`/`function` style), `node:test`, ESLint 8. The plugin source/bundle are unchanged.

---

## Conventions

- `publish.js` is **Node tooling**, not a Duktape module — it does not ship to the device and is linted with a Node `env` override (like `build.js`). The `lib/abrp/*` source and `dist/abrp.js` are untouched by WS2.
- **Green at every step:** after each task `npm test` (fail 0) and `npx eslint lib/ build.js publish.js test/` (exit 0). Commit only when green. Branch `feature/abrp-3.0.0` — commit directly; do NOT push except where a task says so.
- The `gh-pages` git mechanics in Task 2 are verified by a **hermetic integration test** (temp local `file://` repos — no network, no real origin). The high-value deliverable correctness (the manifest + tree bytes) is unit-tested in Task 1.
- Maintainer field uses `Jerry Kezar <kezarjg@gmail.com>` per the approved spec; if you prefer the git-config identity (`jerry@kezarnet.com`), swap it in `buildManifest` — single location.

## File map

| File | Change |
| --- | --- |
| `publish.js` | Create — `buildManifest`/`assemblePages` + `--out` CLI (T1); `publishToGhPages` + `--publish` CLI (T2) |
| `test/publish.test.js` | Create — manifest/assemble unit tests (T1); gh-pages integration test (T2) |
| `package.json` | `stage`/`release` scripts; add `test/publish.test.js` to the test list (T1) |
| `.eslintrc.json` | add `publish.js` to the Node-env override (T1) |
| `.gitignore` | `/dist-pages` (T1) |
| `README.md` | plugin-install primary + hand-copy fallback + cert prerequisite (T3) |
| `CHANGELOG.md`, `docs/SPECIFICATION.md` | T4 |

---

## Task 1: `publish.js` core — manifest + page assembly

**Files:** Create `publish.js`, `test/publish.test.js`; Modify `package.json`, `.eslintrc.json`, `.gitignore`.

- [ ] **Step 1: Write the failing tests**

Create `test/publish.test.js`:

```javascript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --require ./test/globals.js --test test/publish.test.js 2>&1 | grep -E "fail|Cannot find module"`
Expected: FAIL — `Cannot find module '../publish'`.

- [ ] **Step 3: Implement `publish.js` (core + `--out` CLI)**

Create `publish.js`:

```javascript
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
```

- [ ] **Step 4: Add the eslint override, npm scripts, gitignore**

In `.eslintrc.json`, change the `build.js` override's `files` to include `publish.js`:
```json
    {
      "files": ["build.js", "publish.js"],
      "env": { "node": true }
    }
```

In `package.json` `scripts`, add (the `test` script also gains `test/publish.test.js` at the end of its file list):
```json
    "stage": "node build.js --src lib/abrp --entry abrp --out dist/abrp.js && node publish.js --out dist-pages",
    "test": "node build.js --src lib/abrp --entry abrp --out dist/abrp.js && node --require ./test/globals.js --test lib/abrp.test.js lib/abrp/config.test.js lib/abrp/util.test.js lib/abrp/metrics.test.js lib/abrp/queue.test.js test/build.test.js test/publish.test.js"
```

In `.gitignore`, add a line after `/dist`:
```
/dist-pages
```

- [ ] **Step 5: Run tests + lint + a manual stage check**

Run: `node --require ./test/globals.js --test test/publish.test.js 2>&1 | grep -E "pass|fail"` → pass.
Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → fail 0.
Run: `npx eslint lib/ build.js publish.js test/` → exit 0.
Run: `npm run stage && cat dist-pages/plugins.json && ls dist-pages/abrp/` → shows the manifest (version `3.0.0-alpha.1`) and `abrp.js`.

- [ ] **Step 6: Commit**

```bash
git add publish.js test/publish.test.js package.json .eslintrc.json .gitignore
git commit -m "feat(3.0/ws2): plugin manifest generator + page assembly (publish.js)"
```

---

## Task 2: `publishToGhPages` + `release` CLI

Adds the git-worktree publish to `gh-pages` and the `release` script, with a hermetic integration test against temporary local repos.

**Files:** Modify `publish.js`, `test/publish.test.js`, `package.json`.

- [ ] **Step 1: Write the failing integration test**

Append to `test/publish.test.js`:

```javascript
const { execFileSync } = require('child_process')
const { publishToGhPages } = require('../publish')

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
  publishToGhPages(work, stage, 'release 1.0.0')

  let check = path.join(root, 'check1')
  git(['clone', '-b', 'gh-pages', bare, check], root)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(check, 'plugins.json'), 'utf8'))[0].version, '1.0.0')
  assert.ok(fs.existsSync(path.join(check, 'abrp', 'abrp.js')))

  // update
  stage = path.join(root, 'stage2')
  assemblePages(stage, bundle, '2.0.0')
  publishToGhPages(work, stage, 'release 2.0.0')

  check = path.join(root, 'check2')
  git(['clone', '-b', 'gh-pages', bare, check], root)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(check, 'plugins.json'), 'utf8'))[0].version, '2.0.0')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --require ./test/globals.js --test test/publish.test.js 2>&1 | grep -E "fail|not a function"`
Expected: FAIL — `publishToGhPages is not a function`.

- [ ] **Step 3: Implement `publishToGhPages` + `--publish` in `publish.js`**

At the top of `publish.js`, add to the requires:
```javascript
var os = require('os')
var childProcess = require('child_process')
```

Add these functions above `module.exports`:
```javascript
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
```

Update `module.exports`:
```javascript
module.exports = {
  buildManifest: buildManifest,
  assemblePages: assemblePages,
  publishToGhPages: publishToGhPages,
}
```

In the CLI block, add `--publish` handling (replace the existing `else`/`out` CLI body):
```javascript
if (require.main === module) {
  var C = require('./lib/abrp/constants')
  var out = arg('out', null)
  var doPublish = process.argv.indexOf('--publish') !== -1
  if (doPublish) {
    var stage = fs.mkdtempSync(path.join(os.tmpdir(), 'abrp-pages-'))
    assemblePages(stage, 'dist/abrp.js', C.VERSION)
    publishToGhPages(process.cwd(), stage, 'release: abrp ' + C.VERSION + ' plugin repo')
    console.log('publish.js: published abrp ' + C.VERSION + ' to origin/gh-pages')
  } else if (out) {
    var res = assemblePages(out, 'dist/abrp.js', C.VERSION)
    console.log('publish.js: wrote ' + res.manifestPath + ' and ' + res.moduleOut + ' (version ' + C.VERSION + ')')
  } else {
    console.error('publish.js: expected --out <dir> or --publish')
    process.exit(1)
  }
}
```

- [ ] **Step 4: Add the `release` script**

In `package.json` `scripts`, add:
```json
    "release": "node build.js --src lib/abrp --entry abrp --out dist/abrp.js && node publish.js --publish",
```

- [ ] **Step 5: Run tests + lint**

Run: `node --require ./test/globals.js --test test/publish.test.js 2>&1 | grep -E "pass|fail"`
Expected: pass (create + update integration test green). If a `git` invocation errors on your git version, adjust the specific flags to your git's equivalent (the green gate confirms correctness).
Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → fail 0.
Run: `npx eslint lib/ build.js publish.js test/` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add publish.js test/publish.test.js package.json
git commit -m "feat(3.0/ws2): publish the plugin repo to gh-pages (release script)"
```

---

## Task 3: README — plugin install (primary) + hand-copy fallback + cert prerequisite

**Files:** Modify `README.md`.

- [ ] **Step 1: Restructure the Installation section**

In `README.md`, the current "Build the plugin bundle" + "Install the abrp.js Plugin in OVMS" subsections become the **fallback**, and a new plugin-install path leads. Replace those two subsections with:

```markdown
### Install via the OVMS plugin store (recommended)

1. In the OVMS web console, go to **Tools** -> **Shell**.
2. Register this plugin repository and install:

   ```text
   plugin repo install abrp https://kezarjg.github.io/ovms-link/
   plugin install abrp
   ```

3. Reload the JS engine (**Tools** -> **Editor** -> **Reload JS Engine**); expect an
   `ABRP::started` notification. Later, `plugin update` upgrades to new versions.

(No `ovmsmain.js` step — the plugin's module element auto-loads at each JS-engine start.)

### Install manually (fallback)

If you can't use the plugin store, build and hand-copy the single-file bundle. This
requires [Node.js](https://nodejs.org) (the bundler is dependency-free, so **no
`npm install` is needed**):

```bash
npm run build      # emits dist/abrp.js
```

1. In the OVMS web console, **Tools** -> **Editor**; use `/store/scripts/lib/abrp.js`
   for **Path**, **Load**, paste the content of the built `dist/abrp.js`, **Save**.
2. Use `/store/scripts/ovmsmain.js` for **Path**, **Load**, paste the content of the
   repository's `ovmsmain.js`, **Save**.
```

(Keep the existing "Install or update the trusted root CA in OVMS", "Configure Plugin",
and "Reload the JS Engine" subsections that follow — they apply to both methods.)

- [ ] **Step 2: Note that certs are required for both methods**

Immediately above the existing "### Install or update the trusted root CA in OVMS"
heading, add this sentence:

```markdown
**Required for both install methods:** the plugin's TLS connection to
`api.iternio.com` needs the CA certificates below installed (the plugin *install*
itself is already trusted via GitHub Pages). Automatic cert install is planned for a
later release.
```

- [ ] **Step 3: Verify + commit**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → fail 0 (README change doesn't affect tests).
Run: `grep -n "plugin repo install abrp" README.md` → shows the new command.

```bash
git add README.md
git commit -m "docs(readme): plugin-store install (primary) + hand-copy fallback + cert note"
```

---

## Task 4: CHANGELOG + SPECIFICATION

**Files:** Modify `CHANGELOG.md`, `docs/SPECIFICATION.md`.

- [ ] **Step 1: CHANGELOG**

In `CHANGELOG.md`, under `## 3.0.0-alpha.1 (unreleased)`, add:

```markdown
- Installable as an OVMS plugin: `plugin repo install abrp https://kezarjg.github.io/ovms-link/`
  then `plugin install abrp`. A `publish.js` / `npm run release` builds the bundle and
  publishes the plugin repo (`plugins.json` + `abrp/abrp.js`) to a `gh-pages` branch.
  The manual hand-copy install is retained as a fallback.
```

- [ ] **Step 2: SPECIFICATION §12 (installation) + §11 #4**

In `docs/SPECIFICATION.md` §12 (Installation & deployment), add a short paragraph above
the existing numbered steps noting the two paths:

```markdown
The plugin installs two ways: (a) **OVMS plugin store** —
`plugin repo install abrp https://kezarjg.github.io/ovms-link/` then
`plugin install abrp` (the bundle installs to `/store/plugins/abrp/abrp.js` and
auto-loads as `abrp = require("plugin/abrp/abrp")`; no `ovmsmain.js`); or (b) the
**manual hand-copy** of the built `dist/abrp.js` described below. The plugin repo
(`plugins.json` + `abrp/abrp.js`) is published to a `gh-pages` branch by `npm run
release` (`publish.js`).
```

In §11, update item **#4** (plugin-infrastructure deploy) to note it is **partially
addressed in 3.0.0-alpha.1**: gh-pages plugin delivery + `plugin install`/`update` are
implemented (`publish.js`); the openvehicles default-repo submission and the WS3
cert-install bootstrap remain open. Reference
`docs/superpowers/specs/2026-06-05-ws2-plugin-packaging-design.md`.

- [ ] **Step 3: Build, test, lint**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → fail 0.
Run: `npx eslint lib/ build.js publish.js test/` → exit 0.

- [ ] **Step 4: Commit + push**

```bash
git add CHANGELOG.md docs/SPECIFICATION.md
git commit -m "docs(3.0/ws2): plugin install flow + spec §12/§11 #4 updates"
git push 2>&1 | tail -1
```

---

## Out of scope (tracked, not built here)

- **Submitting to the `openvehicles` default repo** (so `plugin install abrp` needs no
  repo URL) — manual PR first; release-time automated PR a later option.
- **Enabling GitHub Pages** is a one-time manual repo-settings action (deploy from
  `gh-pages` branch) — documented, not scriptable in-repo.
- **WS3 cert bootstrap** — automatic curated-root install so the cert step is no longer
  a manual prerequisite.
