# ABRP OAuth2 exploration — findings (for 3.0)

**Date:** 2026-06-02
**Status:** Research / exploration. Some findings are **tentative** (flagged) and
**need confirmation** before designing the 3.0 OAuth2 onboarding.
**Context:** supports 3.0 OAuth2 onboarding (SP2/SP3) and `get_latest_plan` access.
Values below are **sanitized** (no token, name, email, or IDs).

## The flow (from docs + probes)

Classic **authorization-code** OAuth2 (no device-code flow evident):

```
1. Authorize (browser):  https://abetterrouteplanner.com/oauth/auth
                         ?client_id=<id>&scope=<scope>&response_type=code&redirect_uri=<uri>
                         → user logs in / approves → redirect to <uri>?code=XXXX
2. Token exchange:       https://api.iternio.com/1/oauth/token
                         ?client_id=<id>&client_secret=<secret>&code=XXXX  → access_token
3. Identity / use:       https://api.iternio.com/1/oauth/me?api_key=<key>&access_token=<token>
```

Scopes: `get_telemetry`, `set_telemetry`, `get_plan`, `vehicle_history`.

## Probe results (live)

| Probe | Result | Takeaway |
| --- | --- | --- |
| `oauth/me` with the **generic Live-Data token** as `access_token` | **200 `status: ok`** | The generic token carries **identity + telemetry scope** |
| `get_latest_plan` with the generic token | **401** (earlier) | Generic token lacks **`get_plan`** scope |
| `oauth/auth` with `client_id = OVMS_API_KEY`, opened in a **real browser** | **"Connection error, failed to fetch app name."** — the authorize page can't resolve an application for the `client_id`; never reaches approval/redirect | **DISPROVEN: `OVMS_API_KEY` is NOT a registered OAuth2 client.** No OAuth2 application is associated with it. |
| `oauth/token` with `client_id = client_secret = OVMS_API_KEY`, bogus `code` | **400 `invalid_grant`** (not `invalid_client`) | **Red herring** — looked like the client was accepted, but the authorize result above is authoritative: the api_key is not an OAuth2 client. |
| `oauth/auth` fetched via `curl` (no browser) | 200 text/html (SPA shell) | Inconclusive — the shell loads, but client lookup happens in client-side JS (which is what fails in the browser). |
| device-code flow | none found (planning spec only has a separate `/auth/login`) | Must use the redirect-based authorization-code flow |

### `oauth/me` response shape (sanitized)
```jsonc
{ "status": "ok",
  "user_id": <int>, "full_name": "<name>", "email": "<email>",
  "vehicle_id": <int>, "vehicle_name": "<name>", "vehicle_typecode": "<abrp typecode>" }
```
The `vehicle_typecode` is the ABRP model code (e.g. `subaru:solterra:…`), the same
namespace as the plugin's `overrideMetricMap` vehicle handling.

## Implications for 3.0

- **Token-validation / identity (works today, no OAuth2 upgrade):** after a token is
  entered on the SP3 config page, the plugin can call `oauth/me` and show
  *"Connected as <name> — <vehicle_name>"* — instant confirmation the token is valid
  and which ABRP vehicle it maps to. The `vehicle_typecode` can sanity-check that the
  OVMS vehicle and ABRP vehicle agree. **High-value, low-cost SP3 feature.**
- **Plan access needs the full flow:** `get_latest_plan` (and the plan dashboard)
  require a token minted via OAuth2 **with `get_plan` scope** — the generic
  Live-Data token won't do.
- **A dedicated OAuth2 client must be registered with Iternio (CONFIRMED prerequisite).**
  `OVMS_API_KEY` is *not* an OAuth2 client (verified: the authorize page errors with
  *"failed to fetch app name"*). Per the docs, setting up OAuth2 needs an **API key +
  a redirect URL + an application name** registered with Iternio (`contact@iternio.com`).
  This is a **hard dependency** for the whole `get_plan` / plan-dashboard line of work —
  nothing OAuth2 can be built or tested until it exists.
- **The embedded redirect is the *next* hurdle (after registration).** Authorization-code
  flow returns the code on a redirect; an OVMS module has no public callback. Candidate
  strategies (only relevant once a real client + allowed redirect exist):
  - **Redirect to the module's own web-UI** page (the SP3 config page captures
    `?code=…` locally), if the client allows a `http://<module-ip>/…` or `localhost`
    redirect.
  - **Out-of-band "copy the code"** — redirect to a page that displays the code; the
    user pastes it into the config page.
  - Device-code flow is **not** available, so it's not an option.

## Open questions — confirm before implementing

0. ~~Is `OVMS_API_KEY` a registered OAuth2 client?~~ **ANSWERED: no.** Verified in a
   real browser — the authorize page errors *"failed to fetch app name."* A dedicated
   OAuth2 client must be registered with Iternio first.
1. **Register the OAuth2 client** with Iternio (`contact@iternio.com`): obtain a
   `client_id` / `client_secret`, set the **application name** and an allowed
   **`redirect_uri`**. **Everything else below is blocked on this.**
2. **Which redirect strategy** is registered/acceptable for an embedded module (module
   web-UI capture vs. out-of-band copy-code)?
3. **Manual-flow experiment (once a client exists):** complete `oauth/auth`
   (scope `get_plan`) in a browser, exchange the returned `code` at `oauth/token`, then
   call `get_latest_plan` — to capture the **plan response shape** (still unknown; see
   the plan-awareness doc).

## References

- Plan-awareness findings: `docs/research/2026-06-02-abrp-plan-awareness-api-findings.md`
- OAuth2 docs: `https://iternio.com/index.php/abrp-oauth2-api/`
