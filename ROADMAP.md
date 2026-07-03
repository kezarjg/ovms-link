# ovms-link — Release Roadmap

**Last updated:** 2026-07-03
**Current line:** `2.3.0` validated on-vehicle (two weeks) and open as upstream PR
[#43](https://github.com/iternio/ovms-link/pull/43); active development on `3.0.0`
(branch `feature/abrp-3.0.0`, at `3.0.0-alpha.3`).

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
| `2.3.0` | Pipeline + data integrity (incl. overflow fix + test rename) | Hand-installed single file | ✅ validated; PR [#43](https://github.com/iternio/ovms-link/pull/43) open |
| `3.0.0` | Plugin platform (+ bandwidth delta encoding, plan awareness) | OVMS plugin (+ web UI) | OAuth2 redirect; ~~cert bootstrap~~ ✅ |

> The previously-planned `2.4.0` has been **dissolved** — its features moved into
> 3.0.0 (see below). 2.3.0 ships as the validated core with nothing bolted on
> before its first on-vehicle test.

---

## 2.3.0 — Pipeline + data integrity (validated; upstream PR open)

**Status:** validated on-vehicle and open as upstream PR
[#43](https://github.com/iternio/ovms-link/pull/43) (branch `pr/abrp-2.3.0`, a clean
fast-forward on `dev`). 64 unit tests pass, ESLint clean, `DEBUG = false`,
`VERSION = '2.3.0'`, `package.json` 2.3.0. Includes the former 2.3.1 quality fixes
(queue-overflow-during-in-flight removal **by identity**, and the
`arbp.test.js` → `abrp.test.js` rename), folded in since 2.3.0 had not shipped.

Two weeks of field logs (Jun 19–Jul 1, Subaru Solterra) confirmed steady-state
charging is jitter-free, DCFC detection fires on real fast charges, the session
state machine pairs cleanly, and the bounded queue degrades gracefully through a
cellular outage and firmware OTAs with no plugin fault. Beyond the three fixes
listed above, 2.3.0 also carries the level-based session state machine, the AC-charge
cadence fix, and the charge-power deadband.

Completes the half-finished bulk-telemetry refactor and ships it on a current
upstream base: bulk-upload queue, the concurrent-flush and HTTP-200-vs-`status:"ok"`
data-integrity fixes, `capacity`/`soe` wiring, restored median smoothing, a Jest
test suite, CA certs + README from upstream, and a lint-clean source. Detailed in
`docs/superpowers/specs/2026-06-01-abrp-2.3.0-refactor-design.md`.

**Remaining to ship:**

1. **Upstream review** — PR [#43](https://github.com/iternio/ovms-link/pull/43) is
   open for review; on-vehicle validation (the gate) is complete.

## 2.4.0 — dissolved (features moved to 3.0.0)

The intended 2.4.0 features were redistributed rather than shipped as a separate
release:

- **Per-point delta encoding** → 3.0.0 (bandwidth item in the telemetry path).
  Iternio confirmed it is feasible
  ([#41](https://github.com/iternio/ovms-link/issues/41), 2026-06-02): ABRP's
  pipeline carries forward last-known values for omitted keys, and `utc` is the
  only required field per point. **Design note:** it needs care around the
  overflow-drop/retry baseline — a within-batch "full first point" (or an
  across-batch resync-on-drop guard) — so it is not a trivial bolt-on; designed
  properly within 3.0 rather than rushed onto the pre-test 2.3.0 core.
- **Plan-awareness notifications** → 3.0.0 (already covered by the plan/charge
  sub-project: `get_next_charge` / `get_latest_plan`).

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
- **Bandwidth: per-point delta encoding** (from the dissolved 2.4.0) — within a
  bulk batch, points after the first carry `utc` + only changed fields
  (Iternio-confirmed, #41). Must handle the overflow-drop/retry baseline safely
  (full first point per batch, or an across-batch resync-on-drop guard).
- **Plan-awareness notifications** (from the dissolved 2.4.0) — `get_next_charge` /
  `get_latest_plan` driver notifications; part of the plan/charge sub-project.

### Decomposition (3.0 is multiple spec/plan cycles)

Ship as `3.0.0-alpha.N` / `beta.N` milestones, each its own
brainstorm → spec → plan → implement cycle:

1. **Plugin packaging + CA-cert bootstrap** (delivery foundation) — plugin packaging
   implemented in 3.0.0-alpha.1; CA-cert bootstrap **complete** (certdata element
   writes roots to `/store/trustedca` + `tls trust reload` at first run).
2. **Web UI shell + config page + OAuth2 onboarding** (onboarding/observability).
   - **SP2a (web shell + config page + status dashboard + status hook) — implemented
     in 3.0.0-alpha.2.** The config page (`/usr/abrp/config`, admin), status
     dashboard (`/usr/abrp/status`), and status-hook line ship as
     `webpage`/`webhook` plugin elements; the module exposes `webStatus()` and
     `webIdentityRefresh()` as the command-bridge entry points.
   - **SP2b (OAuth2 onboarding + plan dashboard) — deferred (2026-06-06); blocked on
     two external unknowns** that a registration email to Iternio
     (`contact@iternio.com`) must resolve — drafting/sending that email is the
     deferred next action: **(1)** registering a dedicated OAuth2 client (`client_id`,
     app name, an allowed `redirect_uri` workable on an embedded module — it has no
     public callback; device-code flow isn't offered); **(2)** whether `oauth/token`
     supports **PKCE** — because a `client_secret` cannot be shipped in this
     open-source plugin, PKCE (no secret) is required, else a maintainer-run broker
     must do the token exchange. The plan dashboard (`get_latest_plan`, `get_plan`
     scope) is deferred alongside. See
     `docs/research/2026-06-02-abrp-oauth2-findings.md` (open questions 1, 1a, 2).
3. **Plan + charge-control features** (`get_latest_plan` dashboard, `get_next_charge`
   auto-limit) — **not started; the next unblocked headline work.** SP2b's plan
   dashboard is gated on OAuth2, but `get_next_charge`-driven notification/auto-limit
   does not depend on that blocker.

**Also shipped:** adaptive sample cadence (collect-pressure back-off) in
`3.0.0-alpha.3` — the sampler stretches its interval under event-loop congestion and
recovers as collects speed up, motivated by the field-observed `ticker.1` stalls.

**Community signal (RFC [#42](https://github.com/iternio/ovms-link/issues/42), as of
2026-07-03):** early responders (`stumbaumr`, `DragonEndeavour`, `egoetz-zz`) converge
on **plugin packaging + web onboarding (1 & 2) as must-have, delta encoding + dashboard
(3 & 4) as welcome, plan/charge notifications (5) as low priority** — though the
concrete "notify when ABRP charge target reached" framing lands better than generic
plan awareness. Requests: make cadence/threshold constants user-configurable. Test
volunteers: smart forfour ED4 / fortwo ED3, VW e-up. Recurring pain driving these:
unreliable cellular uplink → stale SoC, which the drop-safe queue + heartbeat target
(a BLE→phone bridge was raised but is out of scope — ovms-link is the cloud API path).

### Module split (`lib/abrp/`)

2.x is intentionally a single file to minimise hand-copy install steps. Automated
plugin delivery removes that cost, so 3.0 can split the source into focused,
independently testable modules (organised under `lib/abrp/` in the repo) — e.g.
`core` (pipeline + queue), `api` (Iternio client: `send`/`bulk`, `get_next_charge`,
`get_latest_plan`, OAuth2), `charge` (closed-loop control), and a thin `entry`.

**How modules load under plugin delivery (verified in OVMS source):**

- A plugin install does **not** edit `ovmsmain.js`. At each JS-engine start the
  framework auto-evaluates `<name> = require("plugin/<plugin>/<path>");` for every
  enabled `module` element, independently of (and before) `ovmsmain.js`, which is
  only ever read. So a plugin-delivered `abrp` ships **no `ovmsmain.js`** — the
  entry module is auto-loaded.
- Plugin files install to **`/store/plugins/<name>/`** (not `/store/scripts/`), so
  the in-code require ids must be **`plugin/abrp/<part>`** (e.g.
  `require("plugin/abrp/core")` → `/store/plugins/abrp/core.js`), **not**
  `lib/abrp/...` (that prefix is the hand-install layout under
  `/store/scripts/lib/`).
- **Relative requires (`./core`) do NOT work** — OVMS's resolver ignores the
  parent module id and resolves an id simply as `<id>.js`. Every module references
  its siblings by full id. (Consequence: the require prefix is install-location
  specific, so the same source can't serve both the plugin and hand-install layouts
  unchanged; 3.0 targets plugin delivery → use `plugin/abrp/…`.)
- OVMS Duktape is Node-style CommonJS (`require`/`module.exports`, module cache);
  Jest handles the same `require()` natively, so the split also improves unit-test
  isolation.
- **Caveat:** multiple `module` elements in one plugin manifest is schema-supported
  but untrodden (every existing plugin ships exactly one `module`); confirm the
  auto-wiring loads **only** the entry (which then `require()`s the rest) rather
  than auto-loading every module element. Validate in sub-project 1.

## Out of scope (for now)

- **ABRP Planning API** (route generation): a **paid** key, charged per plan. The
  free `get_latest_plan` covers displaying the plan the user already built.
- **`set_next_charge`** (set the goal from OVMS): niche; reading the goal is the
  common case.

## Dependency summary

| Item | Blocked on |
| --- | --- |
| 2.4.0 delta encoding | Iternio answer to issue #41 |
| 3.0 SP2b OAuth2 onboarding + plan dashboard | Iternio registration email (`contact@iternio.com`) — **deferred/open blocker**: a dedicated OAuth2 client (`client_id` + embedded-workable `redirect_uri`) **and** PKCE support on `oauth/token` (no shippable `client_secret`) |
| 3.0 one-command install | CA-cert bootstrap approach — **resolved in 3.0.0-alpha.1** (certdata element + first-run install) |
| 3.0 openvehicles distribution | Coordination to (re-)publish `abrp` to the default repo |
