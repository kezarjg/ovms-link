# ovms-link — Release Roadmap

**Last updated:** 2026-06-02
**Current line:** `2.3.0` (on branch `refactor/abrp-2.3.0`, in on-vehicle testing)

This roadmap is the plan of record for upcoming work. Items past 2.3.0 are
proposals with explicit gating dependencies — they are not committed until those
are resolved. See `docs/SPECIFICATION.md` for the current system spec and its
§11 follow-ups.

## Versioning policy

The plugin's effective public interface is: the in-vehicle shell commands
(`info` / `onetime` / `send` / `resetConfig`), the configuration keys, and the
**install / delivery model**. Against that:

- **Patch** (`2.3.x`) — internal fixes, no behavior or interface change.
- **Minor** (`2.x.0`) — additive features that do **not** change how the plugin is
  installed or configured; existing setups keep working unchanged.
- **Major** (`3.0.0`) — a change to how the product is **installed / onboarded**, or
  a substantial expansion of product scope. Signals "new way to install and use."

By strict semver most planned work is additive, but the plugin-platform leap
(§3.0) is badged major because it redefines installation and onboarding and is the
point at which the manual hand-copy era is deprecated.

## At a glance

| Version | Theme | Delivery | Gating |
| --- | --- | --- | --- |
| `2.3.0` | Pipeline + data integrity | Hand-installed single file | On-vehicle test |
| `2.3.1` | Quality patch (optional) | Hand-installed single file | — |
| `2.4.0` | Bandwidth + plan awareness | Hand-installed single file | Issue #41 answer |
| `3.0.0` | Plugin platform | OVMS plugin (+ web UI) | OAuth2 redirect; cert bootstrap |

---

## 2.3.0 — Pipeline + data integrity (in testing)

**Status:** implemented on `refactor/abrp-2.3.0`; awaiting on-vehicle validation.

Completes the half-finished bulk-telemetry refactor and ships it on a current
upstream base: bulk-upload queue, the concurrent-flush and HTTP-200-vs-`status:"ok"`
data-integrity fixes, `capacity`/`soe` wiring, restored median smoothing, a Jest
test suite, CA certs + README from upstream, and a lint-clean source. Detailed in
`docs/superpowers/specs/2026-06-01-abrp-2.3.0-refactor-design.md`.

## 2.3.1 — Quality patch (optional)

**Status:** proposed. Could also be folded into 2.4.0.

- Fix the **queue-overflow-during-in-flight** edge case (`SPECIFICATION.md` §11.1):
  remove the in-flight batch by identity, or block the overflow `shift()` while
  `isSending`.
- Rename the misspelled `lib/arbp.test.js` → `lib/abrp.test.js` before any upstream
  PR.

No behavior change for users; quality only.

## 2.4.0 — Bandwidth + plan awareness

**Status:** proposed. Still single-file / hand-installed — additive, low-risk.

- **Per-point delta encoding** in bulk batches (`SPECIFICATION.md` §5.6): omit
  fields unchanged since the previous point in a batch, keeping `utc` + changed
  values. **Gated on Iternio's answer to issue
  [#41](https://github.com/iternio/ovms-link/issues/41)** — must confirm ABRP
  carries forward last-known values rather than treating omission as "no data."
- **Plan-awareness notifications** using free telemetry-API reads that **reuse the
  existing user token** (no new auth):
  - `get_next_charge` → notify the driver of ABRP's target SoC for the next stop.
  - `get_latest_plan` → notify next-stop / ETA / arrival-SoC summaries.
  - Poll sparingly (e.g. `get_next_charge` only while charging, every few minutes)
    to respect the bandwidth goals; both only return data when the user has an
    active plan in ABRP.

Rationale: delivers real value (data savings + plan visibility) without touching
the install model, so it can ship while the platform work below is designed.

## 3.0.0 — Plugin platform (the leap)

**Status:** proposed. Large — **decompose into sub-projects** (see below).

The release where installation, onboarding, and product scope change together:

- **OVMS plugin packaging** (issue
  [#38](https://github.com/iternio/ovms-link/issues/38)): a plugin manifest
  (`name` / `version` / `prerequisites` / `elements`) served from a repository,
  enabling `plugin install` / `plugin update`. The `module` element auto-loads, so
  the manual `ovmsmain.js` wiring goes away. The `openvehicles` repo slot is empty
  (the legacy `abrp 0.1` was removed) and its README already redirects here, so
  this is a clean addition. Routes: an independent Iternio repo and/or
  (re-)publishing to the default `openvehicles` repo.
- **Web UI** (other OVMS plugins ship `webpage`/`hook` `.htm` elements alongside
  the `.js` module):
  - **Config page** — enter the ABRP token via a form instead of `config set`.
  - **Status / plan dashboard** — live sending state, GPS-time-valid, queue depth,
    last send result, current telemetry, and the active plan (`get_latest_plan`),
    optionally charted (à la the `pwrmon`/`auxbatmon` plugins).
  - **Status hook** — inject "ABRP: connected · N queued" into the OVMS status page.
- **OAuth2 onboarding** — acquire the token without manual paste, surfaced from the
  config page. **Gated on a redirect strategy** workable on an embedded module
  (OAuth2 expects a `redirect_uri` + `client_secret`).
- **Closed-loop charging** — `get_next_charge` → notify and/or **auto-limit/stop
  charging at ABRP's planned SoC** using OVMS charge control. Turns the plan into
  vehicle behavior; this is the headline 3.0 capability.
- **CA-certificate bootstrap** — plugin element types do **not** install trusted
  CAs to `/store/trustedca`, so 3.0 must either keep certs a documented manual
  prerequisite or have the plugin write them and run `tls trust reload` at first
  run. **Resolve before claiming a true one-command install.**

### Decomposition (3.0 is multiple spec/plan cycles)

Ship as `3.0.0-alpha.N` / `beta.N` milestones, each its own
brainstorm → spec → plan → implement cycle:

1. **Plugin packaging + CA-cert bootstrap** (delivery foundation).
2. **Web UI shell + config page + OAuth2 onboarding** (onboarding/observability).
3. **Plan + charge-control features** (`get_latest_plan` dashboard, `get_next_charge`
   auto-limit).

### Module split (`lib/abrp/`)

2.x is intentionally a single file to minimise hand-copy install steps. Automated
plugin delivery removes that cost, so 3.0 can split the source into focused,
independently testable modules organised under a `lib/abrp/` directory — e.g.:

- `lib/abrp/core.js` — telemetry pipeline + queue
- `lib/abrp/api.js` — Iternio API client (`send`/`bulk`, `get_next_charge`,
  `get_latest_plan`, OAuth2)
- `lib/abrp/charge.js` — closed-loop charge control
- `lib/abrp.js` — thin entry that `require()`s the parts (keeps
  `require("lib/abrp")` / `ovmsmain.js` unchanged)

OVMS's Duktape uses Node-style CommonJS `require()`/`module.exports` with a module
cache, and resolves nested ids from `/store/scripts/` — `require("lib/abrp/core")`
loads `/store/scripts/lib/abrp/core.js`. Jest handles the same `require()` natively,
so the split also improves unit-test isolation. **Caveat:** delivering several
files via the plugin manifest's `elements` array is schema-supported but untrodden
(every existing plugin ships exactly one `module`); confirm how multiple `module`
elements auto-wire so only the entry is auto-loaded and it `require()`s the rest
(validate in sub-project 1).

## Out of scope (for now)

- **ABRP Planning API** (route generation): a **paid** key, charged per plan. The
  free `get_latest_plan` covers displaying the plan the user already built.
- **`set_next_charge`** (set the goal from OVMS): niche; reading the goal is the
  common case.

## Dependency summary

| Item | Blocked on |
| --- | --- |
| 2.4.0 delta encoding | Iternio answer to issue #41 |
| 3.0 OAuth2 onboarding | Embedded-friendly redirect strategy |
| 3.0 one-command install | CA-cert bootstrap approach |
| 3.0 openvehicles distribution | Coordination to (re-)publish `abrp` to the default repo |
