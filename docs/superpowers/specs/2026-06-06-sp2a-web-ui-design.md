# SP2a — Web UI shell + config page + status dashboard + status hook (design)

**Date:** 2026-06-06
**Branch:** `feature/abrp-3.0.0`
**Milestone:** `3.0.0-alpha.2` (the buildable slice of sub-project 2)

## 1. Goal & scope

Give the plugin a web UI in the OVMS console: a **config page** to enter the ABRP
token (and cadence knobs) with a live "Connected as …" identity check, a read-only
**status dashboard**, and a **status-page hook** line. This replaces the
`config set` / `script eval abrp.info()` shell workflow with point-and-click
onboarding and observability.

### Why this is a slice (decomposition of sub-project 2)

The roadmap's SP2 bundled six things; two are **hard-blocked on an external
dependency** and are split out:

- **SP2a (this spec):** web shell + config page (token + `oauth/me` identity +
  cadence) + status dashboard + status hook. Fully buildable today with the existing
  generic Live-Data token.
- **SP2b (deferred):** OAuth2 onboarding + plan dashboard (`get_latest_plan`).
  **Blocked** — `OVMS_API_KEY` is not a registered OAuth2 client; a dedicated client
  must be registered with Iternio (`contact@iternio.com`) before any OAuth2 work can
  be built or tested (see `docs/research/2026-06-02-abrp-oauth2-findings.md`). Tracked
  separately; a registration-request draft is a side task.

### Decisions (from brainstorming)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Page ↔ module bridge | **Command bridge** — pages call `abrp.webStatus()` / `abrp.webIdentityRefresh()` via the OVMS web command API; functions `print()` JSON | Feasible with no new transport; keeps state where it lives; the `oauth/me` call runs in the module (reuses its TLS/cert/token), not the browser. |
| Auth levels | **Config page = admin; dashboard + hook = open** | The config page edits a credential; read-only status is convenient at a glance. |
| Dashboard data | **Operational + key telemetry** (soc/power/speed/is_charging) | At-a-glance health without duplicating the full `info()` dump. |
| Identity call timing | **Async refresh into a cache; `webStatus` reports the cache** | `HTTP.Request` is async; decoupling avoids relying on async command-output capture. |

### Out of scope

- OAuth2 onboarding and the plan dashboard (SP2b, blocked — above).
- The full telemetry dump on the dashboard (`abrp.info()` still serves that).
- Any change to the telemetry pipeline beyond recording a last-send result.

## 2. Architecture

A bundled **read-surface module** the pages call, plus non-bundled **`.htm` assets**
shipped as `webpage`/`webhook` plugin elements. The `.htm` assets are **not** `module`
elements, so they register pages/hooks rather than clobber the global `abrp`
(see `[[ovms-plugin-module-element-clobbers-global]]`; WS3 lesson).

**Bundled (into `dist/abrp.js`):**

| File | Change | Responsibility |
| --- | --- | --- |
| `lib/abrp/web.js` | **new** | `webStatus()` (prints JSON snapshot), `webIdentityRefresh()` (async `oauth/me`, caches identity). Owns the identity cache. No PEM/secret bytes. |
| `lib/abrp/telemetry.js` | modify | Record `lastResult` (`{ok, code, count, ts}`) on each flush done/fail; add `lastSend()` accessor. |
| `lib/abrp/events.js` | modify | Add `isActive()` accessor (sending on/off). |
| `lib/abrp/iternio.js` | modify | Add `meUrl(token)` (`oauth/me` URL with `api_key` + `access_token`). |
| `lib/abrp/abrp.js` | modify | Wire `Web`; export `webStatus` / `webIdentityRefresh` as stable public entry points; add to `__test`. |

**Not bundled (repo `web/`, shipped by `publish.js`):**

| File | Element | Auth | Path / target |
| --- | --- | --- | --- |
| `web/config.htm` | `webpage` | admin | `/usr/abrp/config` (menu: Config) |
| `web/dashboard.htm` | `webpage` | open | `/usr/abrp/status` (menu: Vehicle) |
| `web/status-hook.htm` | `webhook` | — | OVMS status page (hook point) |

**Verification items** (the design proceeds on documented behavior and unit-tests the
module side; on-device validation is the gate): the exact `webpage`/`webhook` manifest
attribute schema (`page`/`label`/`menu`/`auth`/`hook`) and the web command-bridge call
(`loadcmd("script eval abrp.webStatus()")` and its output capture).

## 3. Module status surface

### `webStatus()` — synchronous, no network, cheap (safe to poll)

Reads state from the owning modules and `print()`s one compact JSON line:

```jsonc
{ "version": "3.0.0-alpha.2",
  "token_set": true,
  "time_valid": true,                 // Ev.isTimeValid()
  "sending": true,                    // Ev.isActive()  (new accessor)
  "queue_depth": 7,                   // Q.getQueue().length
  "last_send": { "ok": true, "code": 200, "count": 12, "ts": "<util.timestamp>" },  // null pre-flush
  "identity": { "state": "ok", "name": "Jane D", "vehicle": "Solterra", "typecode": "subaru:solterra:…" },
  "telemetry": { "soc": 73, "power": -4.2, "speed": 0, "is_charging": false } }
```

- `telemetry`: from `Met.createTelemetry()`, narrowed to the four key fields; each field
  is omitted if its OVMS source has no value (same auto-adapt rule used everywhere).
- `identity`: the **cached** last `oauth/me` result (`state` ∈ `unknown | checking |
  ok | error`), never a live call.
- The whole body is wrapped in try/catch; on any internal error it prints
  `{"error":"…"}` rather than throwing into the command layer.

### `webIdentityRefresh()` — async, decoupled from command output

1. `typeof HTTP === 'undefined'` or no token → set cached `identity = {state:"error",
   error:"…"}`, print a sync ack, return.
2. Set cached `identity.state = "checking"`; fire `HTTP.Request(Iternio.meUrl(token))`:
   - **done** → parse `oauth/me` body → cache `{state:"ok", name, vehicle, typecode}`.
   - **fail** or non-`ok` body → cache `{state:"error", error:…}`.
3. Print a sync ack (`{"ok":true}`) so the command returns immediately.

The config page's **Validate** button calls `webIdentityRefresh()`, then polls
`webStatus()` a beat later to read the updated cached identity.

### New accessors required

`Ev.isActive()`; `Tlm.lastSend()` (returns the `lastResult` recorded in
`sendBulkTelemetry`'s done/fail, `null` until the first flush); `Iternio.meUrl(token)`.
`web.js` owns only the identity cache; everything else it reads through existing owners.

## 4. Web assets

HTML fragments using the OVMS web framework (jQuery + its `loadcmd(command, target)`
bridge). Source in repo `web/`, shipped verbatim as plugin elements.

### `web/config.htm` — `webpage`, auth admin, `/usr/abrp/config`
- Fields: ABRP **user token**, **sample interval** (1–5), **send interval** (10–60).
- On load: populate cadence fields from `config list usr abrp.`. The token field is
  **never echoed** in plaintext — shows a "•••• configured" placeholder when
  `token_set`, accepts a new value.
- **Save** → `config set usr abrp.user_token …` / `…sample_interval …` /
  `…send_interval …` (only for changed fields). Cadence edits take effect live via the
  existing `config.changed` reload — no restart.
- **Validate** → `loadcmd("script eval abrp.webIdentityRefresh()")`, then poll
  `abrp.webStatus()` after a short delay and show the cached identity ("Connected as
  Jane D — Solterra", or the error).

### `web/dashboard.htm` — `webpage`, auth open, `/usr/abrp/status`
- On load and every ~5 s: `loadcmd("script eval abrp.webStatus()")` → parse JSON →
  render operational status (identity, time-valid, sending on/off, queue depth,
  `last_send`) + key telemetry (soc/power/speed/is_charging). Polling is browser-driven
  HTTP over the LAN — **off the module tickers**. Shows "unavailable" on fetch/parse
  failure; clears its timer on page unload.

### `web/status-hook.htm` — `webhook` into the OVMS status page
- Lightweight: calls `abrp.webStatus()` and injects/updates a single line — "ABRP:
  connected · N queued" / "ABRP: idle" / "ABRP: not configured".

### Packaging (`publish.js`)
- `assemblePages` copies `web/*.htm` into the pages tree under `abrp/`.
- `buildManifest` appends three elements after `abrp.js` + `certdata.js`:

```jsonc
{ "type":"webpage", "path":"config.htm",     "name":"abrp_config",      "label":"ABRP Config", "menu":"Config",  "auth":"admin", "page":"/usr/abrp/config" }
{ "type":"webpage", "path":"dashboard.htm",  "name":"abrp_status",      "label":"ABRP Status", "menu":"Vehicle", "auth":"none",  "page":"/usr/abrp/status" }
{ "type":"webhook", "path":"status-hook.htm","name":"abrp_status_hook", "page":"<status page>", "hook":"<hook point>" }
```

(Exact attribute keys for `webpage`/`webhook` and the webhook target page/hook point
are the schema-verification item; `publish.js` tests pin whatever we encode and
on-device validation confirms the menu entries appear and the hook injects.)

## 5. Error handling & resilience

- `webStatus()` never throws into the command layer (try/catch → `{"error":…}`);
  `last_send` is `null` pre-flush; missing telemetry sources are omitted.
- `webIdentityRefresh()` always prints a sync ack; the async done/fail only mutate the
  identity cache; guards no-token and `typeof HTTP === 'undefined'`.
- Pages render "unavailable" on `loadcmd`/parse failure; dashboard clears its timer on
  unload; the token is never echoed back.
- The bundle stays `require()`-able off-device — `web.js` only defines functions; host
  globals are touched at call time, never at load.

## 6. Testing

### On-device/manual gate (cannot be unit-tested)
`.htm`, the browser, `loadcmd`, menu registration, and webhook injection. Checklist:
pages appear in the right menus with correct auth (config prompts admin login;
dashboard open); Save persists config; Validate shows "Connected as X — vehicle";
dashboard polls/updates; the status-page hook line appears; a bad token shows the
error state.

### Unit tests
The `web.js` surface aggregates cross-module state, so its tests run at the **bundle
level** via the existing `loadAbrp(globals)` helper + `__test` seam (which can drive
the queue, sending state, and a flush), with `global.print` overridden to capture the
emitted JSON line:

- `webStatus()` JSON shape for a representative state (token set, time-valid, sending,
  queue depth N, `last_send`, key telemetry); the `last_send: null` pre-flush case; the
  internal-error → `{"error":…}` case.
- `webIdentityRefresh()`: no-token cached error (no HTTP fired); success (stub
  `HTTP.Request` → done with a fake `oauth/me` body → cached `{state:"ok",…}`, surfaced
  by a follow-up `webStatus()`); fail path; sync ack asserted.
- `Tlm.lastSend()` null initially, `{ok:true,code:200,count,ts}` after a 200/`ok`
  flush, `{ok:false,…}` after a fail (extends the existing `sendBulkTelemetry` suite).
- `Ev.isActive()` toggles with `manageVehicleStateEvents(true/false)`;
  `Iternio.meUrl(token)` builds the correct URL (encoded `api_key` + `access_token`).

### `publish.js` tests
Manifest now has **5** elements with the right types/paths/names; `assemblePages`
copies the three `web/*.htm`; regression guard that the web elements are not `module`.
ESLint: `web.js` stays ES2015-safe; `web/*.htm` aren't linted by the source config.

## 7. Affected files

| File | Change |
| --- | --- |
| `lib/abrp/web.js` | **New.** `webStatus`, `webIdentityRefresh`, identity cache, `__test`. |
| `lib/abrp/telemetry.js` | `lastResult` recording + `lastSend()` accessor. |
| `lib/abrp/events.js` | `isActive()` accessor. |
| `lib/abrp/iternio.js` | `meUrl(token)` helper. |
| `lib/abrp/abrp.js` | Wire `Web`; export `webStatus`/`webIdentityRefresh`; `__test`. |
| `web/config.htm`, `web/dashboard.htm`, `web/status-hook.htm` | **New** web assets. |
| `publish.js` | Copy `web/*.htm`; append the three manifest elements. |
| `lib/abrp.test.js` | Bundle-level `web` + `lastSend` tests. |
| `test/publish.test.js` | 5-element manifest + web-asset copy + non-module guard. |
| `docs/SPECIFICATION.md` | New web-UI section; public entry points (`webStatus`/`webIdentityRefresh`); §12 install note (pages appear after install). |
| `CHANGELOG.md` | `3.0.0-alpha.2` web-UI bullet. |
| `ROADMAP.md` | SP2 → SP2a done / SP2b deferred (blocked on Iternio OAuth2 client). |

## 8. Open items to verify on-device

- `webpage`/`webhook` manifest attribute schema and the webhook's target page + hook
  point (`ovms_plugins.cpp` / web framework docs).
- The web command-bridge call and async output behavior (`loadcmd` + `script eval`).
- Whether `auth: "none"` vs a named auth level is the correct token for an open page,
  and `auth: "admin"` for the protected one.
