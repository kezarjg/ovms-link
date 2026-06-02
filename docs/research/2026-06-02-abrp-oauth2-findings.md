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
| `oauth/token` with `client_id = client_secret = OVMS_API_KEY`, bogus `code` | **400 `invalid_grant`** (not `invalid_client`) | **The telemetry api_key appears to double as the OAuth2 client** — client accepted, only the code rejected. *(Tentative)* |
| `oauth/auth` with `client_id = OVMS_API_KEY` | **200 text/html** (login page) | Didn't reject the `client_id`; redirect-URI validation happens on submit, so not conclusive |
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
- **api_key-as-client (tentative):** if `OVMS_API_KEY` really is a registered OAuth2
  client, 3.0 avoids a separate client registration. **Confirm before relying on it.**
- **The embedded redirect is the real hurdle.** Authorization-code flow returns the
  code on a redirect; an OVMS module has no public callback. Candidate strategies:
  - **Redirect to the module's own web-UI** page (the SP3 config page captures
    `?code=…` locally), if the client allows a `http://<module-ip>/…` or `localhost`
    redirect.
  - **Out-of-band "copy the code"** — redirect to a page that displays the code; the
    user pastes it into the config page.
  - Device-code flow is **not** available, so it's not an option.

## Open questions — confirm before implementing

1. **Is `OVMS_API_KEY` a registered OAuth2 client**, and **which `redirect_uri`(s)**
   does it allow? This decides whether any embedded redirect strategy is even viable
   and whether a separate client must be set up with Iternio.
2. **Which redirect strategy** is acceptable for an embedded module (module web-UI
   capture vs. out-of-band copy-code)?
3. **Manual-flow experiment:** complete `oauth/auth` (scope `get_plan`) in a browser,
   exchange the returned `code` at `oauth/token`, then call `get_latest_plan` — to
   capture the **plan response shape** (still unknown; see the plan-awareness doc).
   Requires resolving the redirect_uri question first.

## References

- Plan-awareness findings: `docs/research/2026-06-02-abrp-plan-awareness-api-findings.md`
- OAuth2 docs: `https://iternio.com/index.php/abrp-oauth2-api/`
