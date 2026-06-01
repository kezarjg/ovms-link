# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file [OVMS](https://www.openvehicles.com/) (Open Vehicle Monitoring System)
plugin that streams live EV telemetry to
[A Better Routeplanner (ABRP)](https://abetterrouteplanner.com) via the Iternio
Telemetry API. The deliverable is `lib/abrp.js` plus `ovmsmain.js`, which users
hand-copy into their OVMS device through its web console (see `README.md` for the
install/config flow). There is no build step and nothing is "deployed" — the
source files *are* the product.

## Runtime environment (this constrains everything)

The code runs inside OVMS's **Duktape** JavaScript engine on an embedded module,
not Node. This dictates the entire coding style:

- **Target ECMAScript 2015 only** (`.eslintrc.json` pins `ecmaVersion: 2015`).
  No arrow functions in source logic where `function` is used, no template
  literals, no `let`/destructuring in the hot paths — match the existing `var` +
  string-concatenation style.
- `const` in Duktape is barely more than `var` (see the note at the top of
  `abrp.js`); don't rely on block scoping or immutability guarantees.
- **Global host objects are injected by OVMS, not imported**: `HTTP`,
  `OvmsConfig`, `OvmsMetrics`, `OvmsNotify`, `PubSub`, `performance`, `print`.
  They're declared as ESLint globals in `.eslintrc.json`. There is no `console`
  (use the `Logger` wrapper around `print`) and no `require` except OVMS's own
  module loader (`ovmsmain.js` does `require("lib/abrp")`).

## Architecture of `lib/abrp.js`

It's one module organized top-to-bottom as: constants → `metricMap` →
utilities → telemetry/metric functions → queue & transmission → event handlers →
core control functions → init → `module.exports`.

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
- **Event-driven via PubSub tickers**, not a main loop. Subscriptions are tracked
  in the `subscriptions` map through the `subscribe()`/`unsubscribe()` wrappers
  (which retain PubSub tokens) — always use these wrappers, not `PubSub` directly,
  so unsubscribe works. Flow: `ticker.1` → `checkTime()` waits for valid GPS time,
  then `send(true)` wires up vehicle events; `vehicle.on`/`charge.start` start
  per-second `ticker.1` → `queueTelemetryIfNecessary()`; `ticker.10` →
  `sendBulkTelemetry()` flushes the queue.
- **Two-stage pipeline: collect, then send.** Metrics are gathered into
  `telemetryToSend` (a queue, capped at `MAX_TELEMETRY_QUEUE_SIZE`, oldest dropped
  on overflow) and uploaded in bulk to `/1/tlm/bulk`. Only `onetime()` uses the
  single-shot `/1/tlm/send`. Queued entries are removed only after a 200 response.
- **Adaptive send cadence** lives in `isSignificantTelemetryChange()` +
  `calculateMaxElapsedDuration()`: send immediately on SOC/charging/parked changes,
  otherwise throttle by driving speed vs. `MIN_CALIBRATION_SPEED`, charging state,
  or back off to 24h when parked. `BANDWIDTH_SAVER` and the `collectedMetrics` /
  `medianPowerMetrics()` smoothing path tune this further.

Module state (`user_token`, `isActive`, `isTimeValid`, `telemetryToSend`,
`collectedMetrics`, `lastQueuedTelemetry`, `subscriptions`) is file-level `var`s.

### Tunable constants (top of `abrp.js`)

`DEBUG` (verbose logging), `BANDWIDTH_SAVER`, `MIN_CALIBRATION_SPEED`,
`METRIC_POLL_RATE_DRIVING`, `METRIC_POLL_RATE_CHARGING`,
`METRIC_POLL_STALE_CONNECTION` (kept under the OVMS API key's ~3-min staleness
window), `MAX_TELEMETRY_QUEUE_SIZE`. `OVMS_API_KEY` is the plugin's Iternio app
key; the per-user `user_token` comes from OVMS config (`usr abrp.user_token`).
Bump `VERSION` and update `CHANGELOG.md` for user-facing changes.

## Commands

```bash
npm test                        # jest (lib/arbp.test.js)
npx jest -t "isSignificant"     # run a single test/describe by name
npx eslint lib/ jest.setup.js   # lint (config in .eslintrc.json; test files use an override)
npx prettier --write lib/arbp.test.js jest.setup.js  # format Node-side files only — NOT abrp.js
```

Node version is pinned to 18 (`.nvmrc`). There is no CI configured.

### Testing model (important)

The suite runs green. `lib/abrp.js` is `require()`-able under Jest because its
module-load side effects (the `OvmsConfig` token read and the `overrideMetricMap()`
/ `subscribe('ticker.1', …)` auto-start) are guarded behind
`typeof OvmsConfig !== 'undefined'` checks — off-device, `require()` is
side-effect-free. Tests use the `loadAbrp(globals)` helper (top of
`lib/arbp.test.js`): it calls `jest.resetModules()`, clears the OVMS host globals,
optionally injects per-test stubs (`OvmsMetrics`, `HTTP`, …), and re-requires the
module. `jest.setup.js` provides no-op `print`/`performance` globals.

`module.exports` exposes the public entry points plus pure helpers for testing,
and a `__test` seam (getters/setters over the module-level queue/state) used by
stateful tests — OVMS ignores the extra export. **Do not** reformat `lib/abrp.js`
with Prettier (it is hand-styled for Duktape); the ESLint test-file override
(`ecmaVersion: 2021`) keeps the source guardrail at ES2015.

**Duktape constraint reminder:** never introduce arrow functions, template
literals, or object spread into `lib/abrp.js` (tests may use them freely).

## In-vehicle entry points

These are the user-facing functions exported and invoked via the OVMS shell
(`script eval abrp.<fn>()`); keep their names/behavior stable: `info()`,
`onetime()`, `send(1|0)`, `resetConfig()`.
