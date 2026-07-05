// abrp-web: the ABRP plugin's web UI as a standalone plugin (the backend for the
// config / dashboard / status-hook pages). Kept out of the abrp bundle so that
// bundle stays well under the DukTape task stack limit (see
// docs/plugin-repo-hosting.md). Owns only the identity cache.
//
// DEPENDS on the abrp plugin being installed: it reads operational state via the
// global abrp.snapshot() and validates identity via abrp.meUrl(). If abrp is not
// loaded, webStatus() reports that rather than throwing.
//
// Runtime: OVMS Duktape (ES2015; var + function only, no arrow/template literals).
// On-device it loads as `abrpweb = require("plugin/abrpweb/abrpweb")`; the pages
// call `abrpweb.webStatus()` / `abrpweb.webIdentityRefresh()`. require()-able
// off-device (node:test) with no side effects.

// Cached result of the last oauth/me call. state: unknown|checking|ok|error.
var identity = { state: 'unknown' };

// The abrp plugin's public read surface, or null if abrp isn't loaded.
function abrpApi() {
  return typeof abrp !== 'undefined' ? abrp : null;
}

// Minimal ok-check for the oauth/me response body (status === "ok").
function apiOk(body) {
  try {
    return JSON.parse(body).status === 'ok';
  } catch (e) {
    return false;
  }
}

// Prints a one-line JSON status snapshot for the web pages: the abrp plugin's
// snapshot() plus this plugin's cached identity. Synchronous, no network,
// defensive (any error is printed as {error} rather than thrown at the pages).
function webStatus() {
  try {
    var api = abrpApi();
    var snap = api && api.snapshot ? api.snapshot() : { error: 'abrp plugin not loaded' };
    snap.identity = identity;
    print(JSON.stringify(snap));
  } catch (e) {
    print(JSON.stringify({ error: String(e) }));
  }
}

// Fires an async oauth/me call (URL from abrp.meUrl()) to validate the token and
// cache the identity. Prints a synchronous ack; the callbacks only mutate the
// cache (webStatus surfaces it). No-ops to an error state without a URL/HTTP.
function webIdentityRefresh() {
  var api = abrpApi();
  var url = api && api.meUrl ? api.meUrl() : '';
  if (typeof HTTP === 'undefined' || !url) {
    identity = { state: 'error', error: 'no token' };
    print('{"ok":false}');
    return;
  }
  identity = { state: 'checking' };
  HTTP.Request({
    url: url,
    timeout: 5000,
    done: function (response) {
      if (response.statusCode === 200 && apiOk(response.body)) {
        var b = JSON.parse(response.body);
        identity = {
          state: 'ok',
          name: b.full_name,
          vehicle: b.vehicle_name,
          typecode: b.vehicle_typecode,
        };
      } else {
        identity = { state: 'error', error: 'rejected' };
      }
    },
    fail: function (error) {
      identity = { state: 'error', error: String(error) };
    },
  });
  print('{"ok":true}');
}

module.exports = {
  webStatus: webStatus,
  webIdentityRefresh: webIdentityRefresh,
  __test: {
    getIdentity: function () {
      return identity;
    },
  },
};
