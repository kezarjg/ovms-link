# Design — Upstream PR for ABRP 2.3.0

**Date:** 2026-06-25
**Author:** kezarjg (with Claude)
**Status:** Approved design; next step is the implementation plan (writing-plans).

## Goal

Open a single pull request to **`iternio/ovms-link`** (upstream) targeting its
default branch **`dev`**, contributing the ABRP **2.3.0** work that currently
lives only on the fork (`kezarjg/ovms-link`, branch `refactor/abrp-2.3.0`) and is
deployed/validated on the maintainer's own module. Upstream is at 2.2.0 and has
never received 2.3.0.

2.3.0 is: a modular, unit-testable rewrite of `lib/abrp.js` (metricMap-driven,
change-based bulk/queue pipeline) at behavioral parity, plus reliability fixes
(level-based session state machine, AC-charge cadence) and a charge-power
deadband that cuts the DC-fast-charge point flood.

## Constraints / decisions

- **Scope: code + tests only.** No fork dev-process artifacts go upstream.
- **History: a few curated logical commits**, reconstructed from real history to
  preserve a *true* refactor-at-parity boundary (not a hunk-split of the final file).
- **One PR** (not stacked), off a fresh branch from `upstream/dev`.
- **Review path: an external Iternio maintainer reviews and merges.** The PR
  description must carry a strong narrative (rationale, back-compat, test +
  on-device evidence).

## File scope

Upstream baseline already has: `package.json` (jest/eslint/prettier devDeps,
`"test": "jest"`), `.eslintrc.json`, `.nvmrc`, and the typo-named
`lib/arbp.test.js`. It does **not** have `lib/abrp.test.js` or `jest.setup.js`.

### In the PR (8 files)

| File | Action | Why |
| --- | --- | --- |
| `lib/abrp.js` | modify (~699 lines) | the plugin: refactor + fixes + deadband; `DEBUG=false`, `VERSION='2.3.0'` |
| `lib/abrp.test.js` | add (~818 lines) | the new jest suite (64 tests) |
| `lib/arbp.test.js` | delete | upstream's typo-named test, replaced by the above |
| `jest.setup.js` | add | no-op `print`/`performance` globals the suite needs |
| `package.json` | modify | `version → 2.3.0`; jest `setupFiles` wiring |
| `.eslintrc.json` | modify | test-file ES2021 override so the suite lints clean |
| `ovmsmain.js` | modify | drop `abrp.send(1)` (see below) |
| `CHANGELOG.md` | modify | the folded 2.3.0 entry (dated 2026-06-25) |

### Explicitly excluded (fork-only dev artifacts)

`ROADMAP.md`, `docs/SPECIFICATION.md`, `docs/plans/**`, `docs/specs/**`,
`docs/superpowers/**` (incl. this doc), `CLAUDE.md`, `.gitignore` tweaks.

### `ovmsmain.js` rationale (decided: keep the change)

In 2.3.0, `lib/abrp.js` **auto-starts on `require`** (guarded behind
`typeof OvmsConfig/OvmsMetrics/PubSub !== 'undefined'`): it runs
`overrideMetricMap()` + `subscribe('ticker.1', checkTime)`, and `checkTime`
calls `send(true)` once GPS time is valid. Upstream's `ovmsmain.js` is
`abrp = require("lib/abrp"); abrp.send(1)`.

Keeping `send(1)` is *functionally safe* — the early call (before any `ticker.1`)
hits the `!isTimeValid` guard in `send()` and returns without starting, so there
is no double-start. Its only effect would be a cosmetic boot-time
`ERROR: Cannot send data: GPS time is invalid.` (Empirically, the deployed module
shows zero such errors and 20 real `Start sending data` events, consistent with an
already-updated `ovmsmain.js`.)

We nonetheless **keep the branch's change (remove `send(1)`)** because it matches
the deployed/validated configuration and gives a coherent "auto-start ⇒ no manual
start" story. The PR description and CHANGELOG call this out as the one integration
step for existing users.

## Commit structure (4 curated commits)

Built on the fresh branch, ordered as a readable review story:

1. **refactor:** modular `metricMap` + bulk/queue change-based pipeline,
   test-ready — the structural rewrite of `lib/abrp.js` **at behavioral parity**,
   plus the test harness (`lib/abrp.test.js`, `jest.setup.js`, `package.json` jest
   wiring, `.eslintrc.json` override, delete `lib/arbp.test.js`) and the
   `ovmsmain.js` auto-start change.
2. **fix:** level-based session state machine + symmetric `send()` teardown, and
   AC-charge cadence decided before the not-parked path — with their tests.
3. **feat:** charge-power deadband to cut DCFC point flood — the localized change
   + its tests; commit message carries the on-device validation.
4. **chore:** CHANGELOG + version 2.3.0.

**Parity reconstruction:** commits 1–2 are separated by reverse-applying the two
fix commits (and the deadband) from the final in-scope tree to derive the
refactor-only state, then re-applying them as commits 2–3. The history is merge-y
and interleaved, so feasibility is validated during implementation; the
**fallback** is a 3-commit structure that bundles the fixes into the refactor
commit.

## PR description outline

- **Title:** *ABRP 2.3.0 — modular, tested refactor + reliability fixes + charge-power deadband*
- **Summary** — what 2.3.0 is, in one paragraph.
- **Why** — `lib/abrp.js` becomes a `metricMap`-driven, change-based pipeline that
  is unit-testable off-device (64 tests; no new framework deps).
- **What changed** — refactor (parity) → reliability fixes → deadband, mapped to commits.
- **Backward compatibility** — in-vehicle entry points (`info/onetime/send/resetConfig`)
  unchanged; **the `ovmsmain.js` change** (drop `send(1)`; module auto-starts on
  require) is the one integration step for existing users.
- **Testing** — `npm test` → 64 green; how to run.
- **On-device evidence** — deadband validated (0 sub-kW jitter charging points
  post-deploy vs ~70–80% before), session-state-machine fix, ~90 ms collect.
- **Out of scope** — the 3.0 modular split, delta-encoding, and fork docs.

## Verification gate (before opening the PR)

On the fresh branch:

1. `npm ci` then `npm test` → **64 passing**.
2. `npx eslint lib/` → clean.
3. Confirm no Duktape violations (arrow functions / template literals / object
   spread) in `lib/abrp.js`.
4. Confirm the suite passes on **upstream's pinned Node** (per its `.nvmrc` /
   jest 28), not only the fork's pinned version.
5. **Key invariant:** `git diff refactor/abrp-2.3.0 -- <the 8 in-scope paths>` is
   empty at the branch tip — the curated commits reproduce the validated/deployed
   source byte-for-byte.

## Open risks / to confirm in the plan

- **Parity reconstruction feasibility** given the interleaved/merge-y history
  (fallback = 3-commit bundle).
- **Node/jest compatibility** on upstream's pin vs the fork's.
- **`package.json` version drift** — upstream's is a stale `2.0.0`; we set `2.3.0`
  (pre-existing mismatch, noted, not "fixed" beyond our bump).
- **Behavior-change disclosure** — the deadband intentionally reduces charging
  points; explicitly flagged in the PR, backed by on-device data.

## Out of scope for this work

- Pushing `refactor/abrp-2.3.0` itself upstream (we build a fresh in-scope branch).
- The 3.0 line / modular `lib/abrp/*` split.
- Any docs or roadmap contribution to upstream.
