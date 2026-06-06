# WS3 — CA-certificate bootstrap (design)

**Date:** 2026-06-06
**Branch:** `feature/abrp-3.0.0`
**Milestone:** `3.0.0-alpha.1` (completes sub-project 1 — delivery foundation)
**Resolves:** `docs/SPECIFICATION.md` §11 #4a (cert-install bootstrap), the last open
item in the WS2 plugin-packaging spec
(`docs/superpowers/specs/2026-06-05-ws2-plugin-packaging-design.md`, §9 "WS3 cert
bootstrap").

## 1. Goal & scope

A `plugin install` of `abrp` should install the runtime CA roots into
`/store/trustedca` and run `tls trust reload` **automatically at first run**, so TLS
to `api.iternio.com` works without the manual certificate step. This is the last
piece needed to call the plugin a true one-command install.

**In scope**

- A bundled bootstrap module that, at startup, writes the curated CA roots to
  `/store/trustedca` and runs `tls trust reload`, gated by a config version stamp.
- A second plugin element carrying the cert bytes, generated from `trustedca/*.pem`.
- `publish.js` changes to generate and ship that element; spec/CHANGELOG updates.

**Out of scope**

- OAuth2 onboarding, web UI, plan/charge features (later sub-projects).
- The `openvehicles` default-repo submission (§11 #4b — tracked separately).
- Changing the hand-copy install. The documented manual `trustedca/*` copy stays as
  a fallback; hand-install users keep doing the manual cert step (the bootstrap is a
  no-op off the plugin path — see §6).

## 2. Decisions (from brainstorming)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Cert-byte delivery | **Separate plugin element** (not embedded in the bundle) | Keeps the JS bundle lean; certs stay single-sourced from `trustedca/`. |
| Install trigger | **Config version stamp** (`usr abrp.certs_version` vs baked `CERTS_VERSION`) | Cheapest steady state: an up-to-date device does zero I/O. Bumping the cert set forces a one-time reinstall. |
| Failure UX | **Log-only, self-healing** | No notification noise; failures retry next boot; telemetry self-heals once trust is fixed. |
| Cert set | **The whole curated `trustedca/` set** (currently 4 roots, incl. ISRG Root X1) | Auto-install equals the documented manual set — one source of truth, robust against firmware variation. A redundant root is harmless. |

## 3. Architecture

A clean split between **bootstrap logic** (bundled, testable) and **cert data** (the
separate element):

- **New source module `lib/abrp/certs.js`** — bundled into `dist/abrp.js`; owns its
  own state (per the module-ownership pattern). Exposes `bootstrap()` plus `__test`
  accessors. Carries **no** PEM bytes — logic only.
- **New generated element — the cert data file** — produced by `publish.js` from
  `trustedca/*.pem`, **not** part of `lib/` source. A Duktape-safe JS file installed
  as `/store/plugins/abrp/certdata.js` that does
  `module.exports = [{ file: "gdroot-g2.crt", pem: "-----BEGIN…\n…\n-----END-----\n" }, …]`.
  Shipped as a **`webrsc` element** (download-only) in the manifest.
  - Why `webrsc` and NOT a second `module` element: OVMS's `LoadEnabledModules`
    (verified in `ovms_plugins.cpp`) auto-evaluates every `module` element as
    `<plugin_name> = require("plugin/<plugin_name>/<path>")` — using the **plugin
    name** (`abrp`) as the assignment target, **not** the element's own `name`. A
    second `module` element would therefore execute
    `abrp = require("plugin/abrp/certdata")` at engine start, **clobbering the
    global `abrp`** (the real plugin object) with the cert array and breaking every
    in-vehicle shell command (`abrp.info()`, `abrp.send(1)`, etc.).
  - A `webrsc` element is still **downloaded** to `/store/plugins/abrp/certdata.js`
    by the plugin Download loop (which is type-agnostic), but is **not**
    auto-evaluated. `require("plugin/abrp/certdata")` still resolves because OVMS
    require resolution is purely path-based, independent of element type. `VFS.Save`
    is still used to **write** into `/store/trustedca`.

**Build seam:** `build.js` inlines only *relative* requires (`require('./x')`). The
bootstrap's `require("plugin/abrp/certdata")` is non-relative, so the bundler leaves
it as a runtime require — exactly the external-data seam we want.

## 4. Data flow

`events.js` `startup()` calls `Certs.bootstrap()`, guarded by
`typeof VFS !== 'undefined' && typeof OvmsConfig !== 'undefined'` (like the existing
auto-start side-effects, so the bundle stays `require()`-able and side-effect-free
off-device):

1. `stamp = Number(OvmsConfig.Get("usr", "abrp.certs_version", "0"))`. If
   `stamp >= CERTS_VERSION` → **return immediately** (zero I/O — the steady state).
2. `try { certs = require("plugin/abrp/certdata") } catch (e)` → log, return (retries
   next boot).
3. For each cert, `VFS.Save({ path: "/store/trustedca/" + file, data: pem, done: …, fail: … })`
   — async fan-out; completions tracked by a plain closure counter, with a failure
   flag.
4. When all `VFS.Save` calls have settled **and none failed** → exec `tls trust reload`.
5. On full success → `OvmsConfig.Set("usr", "abrp.certs_version", String(CERTS_VERSION))`
   + log success. Any failure → log, **do not** write the stamp.

**Sequencing:** bootstrap is fire-and-forget; telemetry is **not** gated on it.
`checkTime()` waits for valid GPS time (typically many seconds post-boot), so the
async cert install almost always finishes first; if not, the first HTTPS attempt
simply retries and self-heals once trust reloads.

## 5. Error handling & resilience

The invariant that makes log-only/self-heal safe: **the config stamp is written only
after a fully successful install** (every `VFS.Save` succeeded *and* `tls trust reload`
succeeded). Any failure leaves the stamp untouched, so the whole bootstrap retries on
the next engine start. There is no half-installed state that looks complete.

| Failure | Behavior |
| --- | --- |
| `require("plugin/abrp/certdata")` throws (data element missing/corrupt) | Catch → `Logger` error → return. No saves, no reload, no stamp. Retry next boot. |
| One/more `VFS.Save` `fail` | Mark failure flag; still count the completion. When all settled with ≥1 failure → **skip reload, skip stamp**, log which file(s) failed. Successfully-written files stay on disk (harmless extra roots); next boot rewrites all idempotently. |
| `tls trust reload` exec throws/errors | Log → skip stamp. Files are on disk; next boot re-saves (idempotent) + retries reload. |
| Saves never call back (hang) | No reload, no stamp → retries next boot. No timeout logic (kept simple); accepted. |
| Off-device / hand-install (`typeof VFS === 'undefined'`) | Guard makes `bootstrap()` a no-op; hand-install users keep the documented manual cert step. |
| `startup()` re-entered | An in-progress flag prevents a concurrent second run. |

## 6. Testing model

**On-device validation is the gate** (real `VFS`, `tls`, and the TLS handshake cannot
be unit-tested). Checklist (added to spec §11/§12):

- Fresh `plugin install` → `tls trust list` shows the roots; `/store/trustedca`
  populated; `abrp.onetime()` connects over TLS; `usr abrp.certs_version` is set.
- Reboot → **no** reinstall (steady state, zero I/O).
- Bump `CERTS_VERSION` → reinstall fires exactly once.

**Unit tests** (against the built bundle, with injected stubs):

- **Skip path:** `stamp >= CERTS_VERSION` → assert no `VFS.Save` and no exec calls.
- **Install path:** `stamp < CERTS_VERSION` → one `VFS.Save` per cert with the correct
  `/store/trustedca/<file>` path + PEM; exec called with `tls trust reload`; stamp
  written to `CERTS_VERSION`.
- **Missing data element:** require throws → logged; no exec, no stamp.
- **Save failure:** reload **not** called, stamp **not** written.
- **Reload failure:** stamp **not** written.
- **Guard:** no `VFS` global → `bootstrap()` is a no-op.

**Test seam:** the `VFS.Save` stub invokes `done`/`fail` synchronously so completion
is drivable in-test; `OvmsConfig` Get/Set and the exec global are stubbed. Since
`require("plugin/abrp/certdata")` won't resolve under `node:test`, the cert-data load
goes through an injectable loader on `certs.js`, overridable via the `__test` seam —
tests feed a fake `[{ file, pem }]`.

**`publish.js` test** (reuse the WS2 clean-tree style): the generated `certdata.js`
exports the right array from `trustedca/*.pem`, is ES5/Duktape-safe (no template
literals / arrow functions), and `plugins.json` carries **two** elements.

## 7. Affected files

| File | Change |
| --- | --- |
| `lib/abrp/certs.js` | **New.** Bootstrap logic + state + `__test` seam (incl. injectable cert-data loader). |
| `lib/abrp/events.js` | Call `Certs.bootstrap()` from `startup()` under the `typeof` guard. |
| `lib/abrp/constants.js` | Add `CERTS_VERSION` (bumped by hand when `trustedca/` changes, like `VERSION`). |
| `lib/abrp/abrp.js` | Wire `Certs` into the `__test` seam / exports as needed. |
| `publish.js` | Generate `certdata.js` (ES5/Duktape-safe) from `trustedca/*.pem`; add it as a `webrsc` element (not `module`) to `plugins.json`; copy it into the gh-pages tree. |
| `.eslintrc.json` | Add `VFS` and the command-exec global (e.g. `OvmsCommand`) to `globals`. |
| `lib/abrp.test.js` (or new `lib/abrp/certs.test.js`) | The unit tests in §6. |
| `docs/SPECIFICATION.md` | §11 #4 → cert bootstrap **resolved**; §12 note the plugin auto-installs certs; add the on-device checklist. |
| `CHANGELOG.md` | `3.0.0-alpha.1` bullet: plugin auto-installs CA roots + `tls trust reload` at first run. |

## 8. Open items to verify on-device

- Exact `VFS.Save` option/callback signature and the `tls trust reload` exec surface
  (`OvmsCommand.Exec("tls trust reload")` assumed) — confirm against the running
  module; unit tests stub them.
- `tls trust reload` tolerates a root that duplicates a firmware built-in (expected
  harmless).
</content>
</invoke>
