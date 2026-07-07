# Known issues

Local tracker for bugs/observations not yet filed upstream (the fork has GitHub
Issues disabled, upstream `iternio/ovms-link` is public-only). One `##` section per
issue; note the date and status.

---

## web UI: `webStatus()` poll may keep firing after leaving the dashboard page

- **Filed:** 2026-07-07
- **Status:** FIXED in `web/dashboard.htm` 2026-07-07 (window-singleton timer +
  self-cancel guard) — pending on-device confirmation after next plugin publish
- **Area:** `web/dashboard.htm` (registered at `/usr/abrp/status`)

### Verification (2026-07-07)

Confirmed by two independent lines of evidence:

**1. Framework contract.** The OVMS web framework's page-swap function `setcontent()`
(`ovms_webserver/assets/ovms.js`) tears a page down by calling
`tgt.find(".receiver").unsubscribe()`, `tgt.chart("destroy")`, `tgt.table("destroy")`,
then `tgt.html(text)`, then `tgt.trigger("load")`. It **never fires a `"remove"` or
unload event**, and `#main` itself is never removed — only its inner HTML is replaced.
So `$('#main').one('remove', …)` waits on an event that never fires (and would target
the wrong element regardless), and `clearInterval(timer)` never runs.

**2. On-device log.** Session on 2026-07-07:

| time | log event | meaning |
| --- | --- | --- |
| 06:16:18.329 | `GET /usr/abrp/status` | dashboard loads → starts `setInterval(refresh, 5000)` |
| 06:16:18.469 | first `webStatus()` | immediate `refresh()` |
| every ~5 s | two interleaved cadences ~0.6 s apart | **two** timers alive → stacking across revisits |
| **06:19:00.339** | **`GET /status`** | **user navigates away from the dashboard** |
| 06:19:03 → 06:20:19 | polling continues **79 s** | timer survived navigation — teardown never fired |
| 06:20:19.089 | last poll | stops only when the tab/websocket actually closed |

The 79 s of polling after the user left the dashboard is the empirical fingerprint:
the orphaned `setInterval` keeps POSTing `webStatus()` until the browser tab closes,
not when the page is left.

### Summary

The web UI's `abrpweb.webStatus()` poll may keep firing every 5 s after the user
believes they've left the page. On 2026-07-07 the module log was full of repeated
`script eval abrpweb.webStatus()` executions; the user reports having already
closed/left the ABRP web page, yet the polling continued.

### Observed behavior

`log.txt` on the Solterra bench module (stock OVMS3 slot) showed a steady stream of:

```
06:20:13.519  webserver:  HTTP POST /api/execute
06:20:13.519  webcommand: ... executing: script eval abrpweb.webStatus()
06:20:14.079  webserver:  HTTP POST /api/execute
06:20:14.079  webcommand: ... executing: script eval abrpweb.webStatus()
```

- Calls arrived in **pairs ~0.6 s apart, every ~5 s** → **two independent pollers**
  were running (two tabs, or a tab navigated away from without the timer cleared).
- In this capture the calls did stop at **06:20:19**, coinciding with a manual close
  — but the user does not believe the page was still open by then, which points at
  the timer outliving the visible page.
- No memory leak: `bytes free` stayed flat (~3.27–3.28 M) throughout.

### Root-cause hypothesis

`web/dashboard.htm` drives the poll with a 5 s `setInterval`, and its cleanup is
explicitly best-effort:

```js
var timer = window.setInterval(refresh, 5000);
refresh();
// Best-effort timer cleanup when the page is replaced (verify the exact hook on-device).
$('#main').one('remove', function(){ window.clearInterval(timer); });
```

If the `#main` `remove` hook doesn't fire when the OVMS web UI swaps pages (e.g.
navigating to another menu entry rather than closing the browser tab), the
`setInterval` survives and keeps polling `webStatus()` until the socket/tab is
actually torn down. Multiple visits would stack multiple live intervals — which
matches the observed *two* concurrent pollers.

### Proposed follow-up

- Replace the non-firing `$('#main').one('remove', …)` cleanup. The framework gives
  no arbitrary-teardown event, so options are: (a) store the timer on a window-scoped
  singleton and `clearInterval` any prior one at the top of the page load (kills the
  stacking too), and/or (b) drive the refresh off the framework's own `".receiver"`
  subscription mechanism, which `setcontent()` *does* tear down (`unsubscribe()`).
- Guard against stacking duplicate intervals across revisits (see (a)).
- Consider slowing the poll (5 s → 10–15 s) and/or only polling while the vehicle is
  active, to cut idle log volume regardless.

### Notes

`webStatus()` itself is synchronous and does no network I/O (`abrpweb.js`), so the
cost is log noise + one command stream per poll, not device load.
