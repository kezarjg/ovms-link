# ABRP API exploration — plan-awareness findings (for 3.0 / SP2)

**Date:** 2026-06-02
**Status:** Research / exploration. **More testing required before implementing**
(notably a live driving session — see "Open questions").
**Context:** supports 3.0 SP2 (plan-awareness) and the OAuth2 decision. Values
below are **sanitized** (no token, no real coordinates/odometer/IDs).

## TL;DR

- The lightweight **next-charge target** (`get_next_charge`) is reachable with the
  **existing generic Live-Data token** — *but only reflects the live plan while the
  vehicle is actively connected/driving*. A website-only plan does **not** update it.
- The **full plan** (`get_latest_plan`) is **OAuth2-gated** (the generic token
  `401`s) — confirming the plan dashboard depends on the 3.0 OAuth2 work.

## Two ABRP APIs, two access realities

| API | Base | Our access | Notes |
| --- | --- | --- | --- |
| **Telemetry API** | `https://api.iternio.com/1/tlm/` | **Yes** — we hold the `api_key`; reads also need a user **token** | No published OpenAPI spec (Postman only) |
| **Planning API v2** | `https://api.iternio.com/2/` | **No** — telemetry key gets `401 Unauthorized Key` / `403 missing feature` | Full **OpenAPI 3.0 spec** exists (`/swagger-ui/spec/prod/IternioPlanning.out.yaml`). Only `/plan` is **paid** (per-plan + setup); all other endpoints free but **key-gated** |

The Planning API is broad (route `/plan`, a full **charger database**, **vehicle
models / charge curves / reference consumption**, `/range`, networks, charge-cards)
— potentially useful for 3.0, but requires a **Planning API key** we don't have.

## Telemetry API — endpoint auth + response shapes (live-verified)

Auth: `api_key` (query) for all `tlm/*`; reads additionally require a **user token**.
Verified live against a real account (token redacted, never stored/committed).

### `get_telemetry` — **200** (works with generic token)
Returns the *last* telemetry ABRP holds for the vehicle (regardless of current
connection):
```jsonc
{ "status": "ok", "result": {
    "telemetry": { "lat": <num>, "lon": <num>, "heading": <num>, "odometer": <num>,
                   "speed": <num>, "power": <num>, "soc": <int>, "is_charging": <bool>,
                   "ext_temp": <num>, "elevation": <num>,
                   "calib_ref_cons": <num> },        // ABRP's calibrated ref consumption (Wh/km-ish)
    "timestamp": "<ISO8601+00:00>", "typecode": "<vehicle typecode>",
    "name": "<vehicle name>", "vehicle_id": <int>, "user_id": <int>,
    "telemetry_type": null, "is_connected": <bool> } }
```
- **`is_connected`** indicates whether the vehicle is in a live session.
- **`calib_ref_cons`** is interesting for 3.0 — ABRP returns its own calibrated
  reference consumption, which the UI could surface.

### `get_next_charge` — **200** (works with generic token)
```jsonc
{ "status": "ok", "next_charge": <SoC %>, "result": { "next_charge": <SoC %> } }
```
- The target SoC appears both top-level and under `result`.

### `get_latest_plan` — **401** with the generic token
- Not "no plan" (that would be `200`/empty) — an **auth gate**. The generic
  Live-Data token grants telemetry scope but **not** `get_plan`. Lines up with the
  OAuth2 scopes (`get_telemetry` / `set_telemetry` / `get_plan` / `vehicle_history`).
- ⇒ The full plan structure is only obtainable via an **OAuth2 token** (do during
  the 3.0 OAuth2 work).

### Other (not re-tested here)
`tlm/send`, `tlm/bulk` (used by the plugin today), `get_carmodels_list`
(api_key only, no token — returns the full ABRP model list), `set_next_charge`
(**write** — left untouched), and the OAuth2 set (`oauth/auth` → `oauth/token` →
`oauth/me`).

## Key behavioral finding — `get_next_charge` tracks the *live driving session*, not website plans

Observed: a route planned **on the ABRP website** (next stop `14% → 95%`) did **not**
change `get_next_charge` — it stayed at **`90.0`** while the vehicle was
`is_connected: false` (stale telemetry). The `90` is almost certainly the vehicle's
default "charge to" limit, **not** the plan's computed `95`.

Per the API doc: *"`get_next_charge`: Returns the next charge-to SoC **while the
user is driving**."* The data flow is:

```
vehicle streams live telemetry → ABRP associates it with the active DRIVING plan
  → get_next_charge returns THAT plan's next target
```

So without a live session, `get_next_charge` falls back to a static value; the
plan's real numbers live in `get_latest_plan` (OAuth2).

## Implications for 3.0 / SP2

| Feature | Auth | Constraint | Verdict |
| --- | --- | --- | --- |
| **Next-charge notification** (`get_next_charge`) | existing generic token | Meaningful **only during an active send/driving session** | Easy win, no OAuth2 — but read it **while sending**, don't expect it to track website-only plans |
| **Full plan dashboard** (`get_latest_plan`) | **OAuth2 (`get_plan`)** | — | Confirmed dependency on the 3.0 OAuth2 work; sequence the dashboard *after* OAuth2 |

## Open questions — test before implementing

1. **Does `get_next_charge` update dynamically while driving?** Need a **live (or
   simulated) telemetry session** connected with an active plan to confirm it flips
   to the plan target (e.g. `95`) and tracks recalculations. Not testable with the
   car offline.
2. **Can a simulated `tlm/send` session trigger plan association** (so
   `get_next_charge` returns the plan value) — i.e. can we test without the real car?
3. **Update cadence** — how often does `next_charge` change? Drives the poll
   interval (balance against the bandwidth goals; only poll during active sessions).
4. **Distinguish plan-target vs the static "charge to" limit** — `90` looked like a
   default setting; need to confirm the value's source in each state.
5. **`get_latest_plan` full shape** — capture during the OAuth2 work (needs a
   `get_plan`-scoped token).

## References

- Telemetry API (Postman, JS-rendered): `https://documenter.getpostman.com/view/7396339/SWTK5a8w`
- Planning API v2 OpenAPI: `https://api.iternio.com/swagger-ui/spec/prod/IternioPlanning.out.yaml`
- Issue [#41](https://github.com/iternio/ovms-link/issues/41) — delta encoding (separate thread).
