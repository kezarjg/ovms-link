# Known issues

Local tracker for bugs/observations not yet filed upstream (the fork has GitHub
Issues disabled, upstream `iternio/ovms-link` is public-only). One `##` section per
issue; note the date and status.

---

## web UI: `webStatus()` poll may keep firing after leaving the dashboard page

- **Filed:** 2026-07-07
- **Status:** open — needs on-device teardown-hook verification
- **Area:** `web/dashboard.htm` (also check `web/config.htm`, `web/status-hook.htm`)

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

- Verify the real page-teardown event in the OVMS web console and hook the
  `clearInterval` to something that reliably fires; guard against stacking duplicate
  intervals across revisits.
- Consider slowing the poll (5 s → 10–15 s) and/or only polling while the vehicle is
  active, to cut idle log volume regardless.

### Notes

`webStatus()` itself is synchronous and does no network I/O (`abrpweb.js`), so the
cost is log noise + one command stream per poll, not device load.
