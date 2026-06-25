# Upstream PR for ABRP 2.3.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble a clean, code+tests-only branch off `upstream/dev` as four curated commits reproducing the validated 2.3.0 source byte-for-byte, then open one PR to `iternio/ovms-link:dev`.

**Architecture:** No new code is written. The four commits are reconstructed from real green historical states on the fork's `refactor/abrp-2.3.0` (`7fe91eb` parity → `82aaf9f` both fixes → `3bd1b27` deadband → `52cf4da` finalize) by checking out the in-scope file versions at each stage onto a fresh branch and verifying the jest suite stays green at every step.

**Tech Stack:** git, Node (jest 28, eslint 8 — both already in upstream `package.json`), `gh` CLI for the PR.

## Global Constraints

- **In-scope files only (8):** `lib/abrp.js`, `lib/abrp.test.js`, `jest.setup.js`, `package.json`, `.eslintrc.json`, `ovmsmain.js`, `CHANGELOG.md`, and the deletion of `lib/arbp.test.js`. Touch nothing else.
- **Duktape ES2015:** `lib/abrp.js` must contain no arrow functions, template literals, or object spread. (Verified by grep in Task 5; tests/`jest.setup.js` may use modern JS.)
- **Never reformat `lib/abrp.js` with prettier** — it is hand-styled for Duktape.
- **`DEBUG = false`** in the released `lib/abrp.js` (lands in commit 4).
- **PR base:** `iternio/ovms-link` branch `dev`. **PR head:** fork branch `pr/abrp-2.3.0` on `kezarjg/ovms-link` (remote `origin`).
- **Tip invariant:** after commit 4, `git diff refactor/abrp-2.3.0 -- <in-scope paths>` must be empty.
- **Stage commits (exact SHAs):** parity `7fe91eb`, fixes `82aaf9f`, deadband `3bd1b27`, finalize `52cf4da`.

---

### Task 1: Create the branch and the parity commit (stage 1)

**Files:**
- Create branch `pr/abrp-2.3.0` off `upstream/dev`
- Modify (from `7fe91eb`): `lib/abrp.js`, `lib/abrp.test.js`, `jest.setup.js`, `package.json`, `.eslintrc.json`, `ovmsmain.js`
- Delete: `lib/arbp.test.js`

**Interfaces:**
- Consumes: the fork commit `7fe91eb` (refactor at behavioral parity, harness present, `ovmsmain.js` already without `send(1)`, `arbp.test.js` already removed).
- Produces: branch `pr/abrp-2.3.0` with one commit; a green jest suite; `node_modules` installed for later tasks.

- [ ] **Step 1: Refresh upstream and create the branch**

```bash
cd ~/ovms-link
git fetch upstream
git switch -c pr/abrp-2.3.0 upstream/dev
```

- [ ] **Step 2: Bring the parity in-scope files from 7fe91eb and delete the typo test**

```bash
git checkout 7fe91eb -- lib/abrp.js lib/abrp.test.js jest.setup.js package.json .eslintrc.json ovmsmain.js
git rm lib/arbp.test.js
```

- [ ] **Step 3: Install deps and run the suite (must be green at parity)**

```bash
npm ci
npx jest 2>&1 | tail -5
```
Expected: `Tests:` line shows all passing (parity-stage count; no deadband/fix tests yet), `Test Suites: 1 passed`.

- [ ] **Step 4: Lint the source**

```bash
npx eslint lib/ 2>&1 | grep -v 'npm notice'; echo "exit: ${PIPESTATUS[0]}"
```
Expected: `exit: 0`.

- [ ] **Step 5: Confirm only in-scope files are staged/changed**

```bash
git status --short
```
Expected: only the six modified in-scope files + the `lib/arbp.test.js` deletion (and `package-lock.json` if `npm ci` touched it — `git checkout -- package-lock.json` to discard if so). `CHANGELOG.md` must NOT appear.

- [ ] **Step 6: Commit the parity stage**

```bash
git add lib/abrp.js lib/abrp.test.js jest.setup.js package.json .eslintrc.json ovmsmain.js lib/arbp.test.js
git commit -m "refactor: modular metricMap + change-based bulk/queue pipeline, test-ready

Restructure lib/abrp.js into a metricMap-driven, change-based telemetry
pipeline that is unit-testable off-device. No behavioral change vs 2.2.0;
adds a jest suite (lib/abrp.test.js, jest.setup.js), the ES2021 test-file
eslint override, and the package.json jest wiring. ovmsmain.js drops the
explicit abrp.send(1) because the module now auto-starts on require.
Replaces the typo-named lib/arbp.test.js."
```

---

### Task 2: Reliability fixes commit (stage 2)

**Files:**
- Modify (from `82aaf9f`): `lib/abrp.js`, `lib/abrp.test.js`

**Interfaces:**
- Consumes: branch tip from Task 1; merge commit `82aaf9f` (both the cadence fix `56a0884` and the session state-machine fix `914e552`).
- Produces: second commit; suite still green with the fix tests added.

- [ ] **Step 1: Bring the fixes' in-scope files**

```bash
git checkout 82aaf9f -- lib/abrp.js lib/abrp.test.js
```

- [ ] **Step 2: Run the suite (green, now includes fix tests)**

```bash
npx jest 2>&1 | tail -3
```
Expected: all passing; the `Tests:` count is higher than Task 1.

- [ ] **Step 3: Confirm scope (only the two files changed)**

```bash
git status --short
```
Expected: only `lib/abrp.js` and `lib/abrp.test.js` modified.

- [ ] **Step 4: Commit**

```bash
git add lib/abrp.js lib/abrp.test.js
git commit -m "fix: level-based session state machine + AC-charge cadence

Feed the four session events (vehicle.on/off, charge.start/stop) through a
single level-based handler (v.e.on || v.c.charging) so a charge.stop no
longer kills the per-second sampler mid-drive and overlapping on+charging
no longer double-subscribes; make send() teardown symmetric with setup; and
decide a charge session before the not-parked path so a momentarily-absent
is_parked (Toyota e-TNGA dropping v.e.gear while plugged in) no longer
throttles AC charging onto the 160 s stale-connection cadence. With tests."
```

---

### Task 3: Charge-power deadband commit (stage 3)

**Files:**
- Modify (from `3bd1b27`): `lib/abrp.js`, `lib/abrp.test.js`

**Interfaces:**
- Consumes: branch tip from Task 2; commit `3bd1b27` (deadband). Note: `3bd1b27` also touched `CHANGELOG.md` — do NOT take it here; CHANGELOG is deferred to Task 4.
- Produces: third commit; suite green with the 7 deadband tests.

- [ ] **Step 1: Bring only the deadband's code + tests (not CHANGELOG)**

```bash
git checkout 3bd1b27 -- lib/abrp.js lib/abrp.test.js
```

- [ ] **Step 2: Run the suite (green, +7 deadband tests)**

```bash
npx jest 2>&1 | tail -3
```
Expected: all passing; `Tests:` count is Task 2's + 7.

- [ ] **Step 3: Confirm scope and commit**

```bash
git status --short   # expect only lib/abrp.js + lib/abrp.test.js
git add lib/abrp.js lib/abrp.test.js
git commit -m "feat: charge-power deadband to cut DCFC point flood

isSignificantTelemetryChange treats a charging power move as significant
only at >= CHARGE_POWER_DELTA_KW (default 1 kW), replacing the round(power)
compare that fired on sub-kW jitter crossing an integer boundary. Measured
against the last queued point so a slow ramp still accumulates; SoC and
state changes still queue normally. On-device validation: post-deploy
charging sessions show 0 sub-kW jitter points vs ~70-80% before. With tests."
```

---

### Task 4: Finalize commit — DEBUG off + CHANGELOG (stage 4)

**Files:**
- Modify (from `52cf4da`): `lib/abrp.js` (DEBUG flip only), `CHANGELOG.md` (final folded 2.3.0 section)

**Interfaces:**
- Consumes: branch tip from Task 3; commit `52cf4da`.
- Produces: fourth/final commit; branch tip in-scope tree identical to `refactor/abrp-2.3.0`.

- [ ] **Step 1: Bring the finalized lib/abrp.js (DEBUG=false) and the folded CHANGELOG**

```bash
git checkout 52cf4da -- lib/abrp.js CHANGELOG.md
```

- [ ] **Step 2: Verify DEBUG is false and the 2.3.0 changelog section is present**

```bash
grep -n 'const DEBUG' lib/abrp.js          # expect: const DEBUG = false
grep -n '^## Version 2.3.0' CHANGELOG.md    # expect the 2026-06-25 heading
```

- [ ] **Step 3: Confirm the CHANGELOG only ADDS the 2.3.0 section (2.2.0-and-below unchanged vs upstream)**

```bash
git diff upstream/dev -- CHANGELOG.md | grep '^-' | grep -v '^---' | head
```
Expected: no meaningful removals (only the `## Unreleased`/old-date lines if any) — i.e. the diff is additive (the new 2.3.0 block). If real historical content below 2.2.0 differs, stop and reconcile.

- [ ] **Step 4: Run the suite (DEBUG flip must not break tests)**

```bash
npx jest 2>&1 | tail -3
```
Expected: all passing (same count as Task 3 — 64).

- [ ] **Step 5: Commit**

```bash
git add lib/abrp.js CHANGELOG.md
git commit -m "chore: finalize 2.3.0 (DEBUG off, changelog)

Flip DEBUG to false for release and add the 2.3.0 CHANGELOG section."
```

---

### Task 5: Verification gate

**Files:** none (read-only checks)

**Interfaces:**
- Consumes: the 4-commit branch from Tasks 1–4.
- Produces: a go/no-go signal before pushing.

- [ ] **Step 1: Tip invariant — in-scope tree identical to the validated source**

```bash
git diff --stat refactor/abrp-2.3.0 -- lib/abrp.js lib/abrp.test.js jest.setup.js package.json .eslintrc.json ovmsmain.js CHANGELOG.md
```
Expected: **empty output.** (Non-empty = reconstruction diverged; stop and fix.)

- [ ] **Step 2: Exactly four commits, code+tests scope only**

```bash
git log --oneline upstream/dev..HEAD
git diff --name-only upstream/dev..HEAD
```
Expected: 4 commits; file list is exactly the 8 in-scope paths (with `lib/arbp.test.js` shown deleted). No docs/roadmap/spec files.

- [ ] **Step 3: Duktape constraint grep on lib/abrp.js**

```bash
grep -nE '=>|`|\.\.\.' lib/abrp.js | grep -v '://' | head
```
Expected: no arrow functions / template literals / object spread (matches on `//` URLs or `>=`/`<=` are fine — inspect any hit).

- [ ] **Step 4: Full suite + lint, on upstream's pinned Node**

```bash
cat .nvmrc                      # note the pinned version
nvm use 2>/dev/null || true     # if nvm present, switch to .nvmrc
npm ci && npx jest 2>&1 | tail -3
npx eslint lib/ 2>&1 | grep -v 'npm notice'; echo "exit: ${PIPESTATUS[0]}"
```
Expected: `Tests: 64 passed`, eslint `exit: 0`.

---

### Task 6: PR description and open the PR

**Files:**
- Create: `/tmp/claude-1000/-home-devuser-ovms-link/fe49ed81-8763-46f4-9fd9-71af50675537/scratchpad/PR_BODY.md` (PR body, not committed)

**Interfaces:**
- Consumes: the verified branch.
- Produces: a pushed fork branch and an open PR against `iternio/ovms-link:dev`.

- [ ] **Step 1: Write the PR body**

Write this to the scratchpad `PR_BODY.md`:

```markdown
## ABRP 2.3.0 — modular, tested refactor + reliability fixes + charge-power deadband

### Summary
2.3.0 restructures `lib/abrp.js` into a `metricMap`-driven, change-based
telemetry pipeline that is unit-testable off-device (64 jest tests), then adds
two reliability fixes and a charge-power deadband. No new runtime dependencies.

### What changed (maps to the commits)
1. **refactor** — `metricMap` + change-based bulk/queue pipeline at behavioral
   parity with 2.2.0; adds the jest suite + harness. `ovmsmain.js` drops the
   explicit `abrp.send(1)` (the module now auto-starts on `require`).
2. **fix** — level-based session state machine (a `charge.stop` no longer kills
   the sampler mid-drive; no double-subscribe) + AC-charge cadence decided
   before the not-parked path (Toyota e-TNGA gear quirk).
3. **feat** — charge-power deadband: a charging power move counts as significant
   only at ≥ 1 kW, killing the DC-fast-charge sub-kW jitter point flood.
4. **chore** — `DEBUG=false` + 2.3.0 changelog.

### Backward compatibility
In-vehicle entry points (`info` / `onetime` / `send` / `resetConfig`) are
unchanged. **One integration step for existing installs:** remove `abrp.send(1)`
from `ovmsmain.js` — the module auto-starts on `require`. Leaving it is harmless
(the early call hits the GPS-time guard and returns) but logs a benign startup
error until GPS locks.

### Testing
`npm test` → 64 passing. No framework deps beyond the existing
jest/eslint/prettier devDeps.

### On-device evidence
- **Deadband:** post-deploy charging sessions show **0** sub-kW jitter points vs
  ~70–80% before — ~68% of charging points were sub-kW jitter.
- **Session fix:** unplug-then-drive sessions are now sampled; no mid-drive
  sampler death.

### Out of scope
The 3.0 modular split, delta-encoding, and project docs are not part of this PR.
```

- [ ] **Step 2: Push the fork branch**

```bash
git push -u origin pr/abrp-2.3.0
```

- [ ] **Step 3: CONFIRM WITH USER, then open the PR**

This is the outward-facing step — confirm before running. Then:

```bash
gh pr create --repo iternio/ovms-link --base dev \
  --head kezarjg:pr/abrp-2.3.0 \
  --title "ABRP 2.3.0 — modular tested refactor + reliability fixes + charge-power deadband" \
  --body-file "/tmp/claude-1000/-home-devuser-ovms-link/fe49ed81-8763-46f4-9fd9-71af50675537/scratchpad/PR_BODY.md"
```
Expected: prints the new PR URL.

- [ ] **Step 4: Report the PR URL to the user.**

---

## Self-Review

**Spec coverage:** scope (code+tests, 8 files) → Tasks 1–4; curated 4 commits via parity reconstruction → Tasks 1–4 stage chain; verification gate (tests, eslint, Duktape, upstream-Node, tip invariant) → Task 5; PR narrative + base/head + external-reviewer framing → Task 6; `ovmsmain.js` keep-the-change → Task 1 + PR body. CHANGELOG-fold handled by deferring to commit 4. All spec sections covered.

**Placeholder scan:** no TBD/TODO; every step has exact commands and the full PR body. Clear.

**Type/identifier consistency:** stage SHAs (`7fe91eb`/`82aaf9f`/`3bd1b27`/`52cf4da`), branch name (`pr/abrp-2.3.0`), and the 8 in-scope paths are used identically across all tasks.
