# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An [OVMS](https://www.openvehicles.com/) (Open Vehicle Monitoring System) plugin
that streams live EV telemetry to
[A Better Routeplanner (ABRP)](https://abetterrouteplanner.com) via the Iternio
Telemetry API. The source lives as focused CommonJS modules under `lib/abrp/`
(`constants`, `util`, `config`, `metrics`, `queue`, `iternio`, `telemetry`,
`events`, and a thin `abrp` entry). A dependency-free bundler (`build.js`)
concatenates them into a single Duktape-safe **`dist/abrp.js`** — that bundle is
the deliverable users hand-copy into their OVMS device through its web console
(plus `ovmsmain.js`; see `README.md` for the install/config flow).

> History: the 2.x line shipped a single hand-edited `lib/abrp.js`. The 3.0 line
> (this branch) split it into independently testable modules + a build step. The
> bundle is the product — nothing is "deployed". Plugin-based delivery (manifest,
> `plugin install`) is a later 3.0 sub-project; for now the bundle is still
> hand-copied.

## Runtime environment (this constrains everything)

The code runs inside OVMS's **Duktape** JavaScript engine on an embedded module,
not Node. This dictates the entire coding style:

- **Target ECMAScript 2015 only** (`.eslintrc.json` pins `ecmaVersion: 2015`).
  No arrow functions in source logic where `function` is used, no template
  literals, no `let`/destructuring in the hot paths — match the existing `var` +
  string-concatenation style.
  These constraints apply to every `lib/abrp/*.js` source file **and** the emitted
  `dist/abrp.js` (the bundler fails the build on arrow functions / template
  literals in emitted code).
- `const` in Duktape is barely more than `var` (see the note at the top of
  `lib/abrp/abrp.js`); don't rely on block scoping or immutability guarantees.
- **Global host objects are injected by OVMS, not imported**: `HTTP`,
  `OvmsConfig`, `OvmsMetrics`, `OvmsNotify`, `PubSub`, `performance`, `print`.
  They're declared as ESLint globals in `.eslintrc.json`. There is no `console`
  (use the `Logger` wrapper around `print`). The `lib/abrp/*` modules use CommonJS
  `require('./x')` to reference each other, but that graph is resolved by `build.js`
  **at build time** — the device only ever loads the single bundle, never the
  individual modules. (`ovmsmain.js` does `require("lib/abrp")` to load it.)

## Architecture (`lib/abrp/` modules → `dist/abrp.js`)

The source is split into focused CommonJS modules, each owning its own state and
exposing accessor functions; the thin `abrp` entry wires them together. Build with
`npm run build` (or `npm test`, which builds first):

| module | owns / responsibility |
| --- | --- |
| `constants.js` | the tunable constants (incl. `VERSION`, `OVMS_API_KEY`) |
| `util.js` | `Logger`, `round`, `clone`, `timestamp` |
| `config.js` | `user_token` — `token()`/`validate()`/`reset()` |
| `metrics.js` | `metricMap` + `overrideMetricMap`/`getOVMSMetric`/`createTelemetry` |
| `queue.js` | the telemetry queue, the interval-gated `sample`/`enqueue`, per-field `roundTelemetry` + `changedVsLastQueued`, last-queued + monotonic cadence baselines |
| `iternio.js` | Iternio API URL builder (`apiUrl`) + `isApiOk` |
| `telemetry.js` | `sendTelemetry`/`sendBulkTelemetry` + the `isSending` in-flight guard |
| `events.js` | PubSub subscriptions, vehicle on/off callbacks, GPS-time gating, `send()` |
| `abrp.js` | thin entry: `info`/`onetime`/`send`/`resetConfig` + `module.exports` + `__test` |

`build.js` resolves the relative `require('./x')` graph at build time and emits one
self-contained, Duktape-safe file. The test suite runs against that bundle (see
Testing model), so each module change is regression-checked end-to-end.

Key concepts to understand before editing:

- **`metricMap`** is the heart of the design. It's an array mapping each ABRP/Iternio
  telemetry key to the OVMS metric(s) it needs (`requiredMetrics`) and a `metric()`
  function that computes the value. A metric is only sent if all its
  `requiredMetrics` report a value (`OvmsMetrics.HasValue`), so the plugin
  auto-adapts to whatever a given vehicle supports. To add a telemetry field, add
  an entry here — don't thread it through individual functions.
- **`overrideMetricMap()`** mutates `metricMap` at startup (and on the
  `vehicle.type.set` event) for vehicle-specific quirks, keyed on
  `OvmsMetrics.Value('v.type')` (e.g. `'NL'` Nissan Leaf, `'KS'` Kia Soul,
  `'TOYBZ4X'`/`'SUBSOL'` Toyota e-TNGA). Vehicle overrides live here, in a switch.
- **Event-driven via PubSub tickers** (`events.js`), not a main loop. Subscriptions
  are tracked in the `subscriptions` map through the `subscribe()`/`unsubscribe()`
  wrappers (which retain PubSub tokens) — always use these wrappers, not `PubSub`
  directly, so unsubscribe works. Flow: `ticker.1` → `checkTime()` waits for valid
  GPS time, then `send(true)` wires up vehicle events; `vehicle.on`/`charge.start`
  start per-second `ticker.1` → `Q.sample()` (`queue.js`); `ticker.10`
  → `sendBulkTelemetry()` (`telemetry.js`) flushes the queue.
- **Change-based pipeline: sample, change-detect, then send.** The queue
  (`telemetryToSend` in `queue.js`, capped at `MAX_TELEMETRY_QUEUE_SIZE`, oldest dropped
  on overflow) holds **full snapshots** and is uploaded in bulk to `/1/tlm/bulk`. The
  bulk POST is **delta-encoded** in `createBulkPost` (`telemetry.js`): the first point of
  each batch is full (a per-flush resync, drop-safe), the rest carry `utc` + changed
  fields only. Only `onetime()` uses the single-shot `/1/tlm/send`. Queued entries are
  removed only after a 200 (+ `status:"ok"`) response.
- **Change-based cadence** lives in `queue.js`'s `sample()`/`enqueue()`: `ticker.1` is
  throttled via an `m.monotonic` elapsed-time gate to a configurable `sampleInterval`
  (`usr abrp.sample_interval`, validated 1–5, default `SAMPLE_INTERVAL_DEFAULT = 3` s,
  via `Cfg.sampleInterval()`). Each sample takes a full snapshot, rounds each field per
  the `ROUNDING` precision map, and **enqueues only if a rounded field changed** vs. the
  last queued point (`changedVsLastQueued`); otherwise a **heartbeat**
  (`HEARTBEAT_INTERVAL`, default 160 s, `0` disables) forces a point to keep the ABRP
  session alive. Vehicle-on enqueues a natural full bookend; vehicle-off enqueues a
  bookend forced to a coherent parked state (`speed`/`power` = 0, `is_parked` = true,
  `is_charging`/`is_dcfc` = false).

Each module owns its own mutable state and is the only one that mutates it; other
modules go through its exported accessors (extending the `__test` seam pattern).
`config.js` owns `user_token`; `queue.js` owns `telemetryToSend`/`lastQueuedTelemetry`
and the monotonic cadence baselines (`lastSampleMono`/`lastQueuedMono`); `telemetry.js`
owns `isSending`; `events.js` owns `subscriptions`/`isActive`/time-valid. All are
module-level `var`s.

### Tunable constants (`constants.js`)

`DEBUG` (verbose logging), `SAMPLE_INTERVAL_DEFAULT` (default seconds between
samples; overridden per-user by `usr abrp.sample_interval`, validated 1–5),
`SEND_INTERVAL_DEFAULT` (default bulk-flush interval in seconds, `30`; overridden
per-user by `usr abrp.send_interval`, validated 10–60), `HEARTBEAT_INTERVAL`
(keep-alive seconds, kept under the OVMS API key's ~3-min staleness window; `0`
disables), `ROUNDING` (per-field precision map, also the change threshold),
`MAX_TELEMETRY_QUEUE_SIZE`. `OVMS_API_KEY` is the plugin's Iternio app key; the
per-user `user_token` comes from OVMS config (`usr abrp.user_token`). Bump
`VERSION` and update `CHANGELOG.md` for user-facing changes.

## Commands

```bash
npm run build                   # bundle lib/abrp/*.js -> dist/abrp.js (build.js)
npm test                        # builds the bundle, then runs the node:test suite against dist/abrp.js
# run one file (rebuild first so the bundle reflects your edits):
npm run build && node --require ./test/globals.js --test lib/abrp.test.js
# filter by test name within a run:
npm run build && node --require ./test/globals.js --test --test-name-pattern="changedVsLastQueued" lib/abrp.test.js
npx eslint lib/ build.js test/   # lint (config in .eslintrc.json; *.test.js + build.js use overrides)
npx prettier --write lib/abrp.test.js test/globals.js  # format Node-side files only — NOT lib/abrp/*
```

Tests use Node's built-in runner (`node:test` + `node:assert`) — no test-framework
dependency. `node --test` alone does **not** rebuild, and it loads `test/globals.js`
(no-op `print`/`performance` stubs) via `--require`, so always invoke it the way the
`test` script does (or just run `npm test`). Node is pinned to 22 (`.nvmrc`); `node:test`
is stable on Node 20+. There is no CI configured. `/dist` is gitignored (build artifact).

### Testing model (important)

The suite runs green **against the built bundle** with Node's built-in `node:test`
runner: `npm test` first runs `build.js` to emit `dist/abrp.js`, then the runner. The
bundle is `require()`-able off-device because the entry's auto-start side effects (the
`overrideMetricMap()` / `subscribe('ticker.1', …)` inside `Ev.startup()`) are guarded
behind `typeof OvmsConfig/OvmsMetrics/PubSub !== 'undefined'` checks — off-device,
`require()` is side-effect-free. The main suite (`lib/abrp.test.js`) uses the
`loadAbrp(globals)` helper: it drops the bundle from `require.cache` and re-requires it
(the bundle is self-contained, so this re-runs its internal module registry → fresh
queue/metricMap/state — the replacement for `jest.resetModules()`), clears the OVMS host
globals, and optionally injects per-test stubs (`OvmsMetrics`, `HTTP`, …). Per-module
tests (`lib/abrp/util.test.js`, `lib/abrp/metrics.test.js`) require the source modules
directly. `test/globals.js` provides the no-op `print`/`performance` globals (loaded via
`--require`).

`module.exports` (in the `abrp` entry) exposes the public entry points plus pure
helpers for testing, and a `__test` seam delegating to the owning modules' accessors
(`Q.getQueue`, `Q.setCollected`, …) — OVMS ignores the extra export. **Do not**
reformat `lib/abrp/*.js` with Prettier (hand-styled for Duktape); the ESLint override
for `*.test.js` + `test/**` (`ecmaVersion: 2021`, Node `env`) keeps the source guardrail
at ES2015, and a `build.js` override enables the Node `env` for the build script.

**Duktape constraint reminder:** never introduce arrow functions, template literals,
or object spread into `lib/abrp/*.js` or the emitted bundle (test files may use them
freely). The `build.js` safety guard rejects the worst offenders, but it only scans
emitted code — keep the source clean.

## In-vehicle entry points

These are the user-facing functions exported and invoked via the OVMS shell
(`script eval abrp.<fn>()`); keep their names/behavior stable: `info()`,
`onetime()`, `send(1|0)`, `resetConfig()`.
