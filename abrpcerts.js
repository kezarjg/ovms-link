// abrp-certs: a standalone OVMS plugin that installs the CA roots the ABRP plugin
// needs (for its TLS connection to api.iternio.com) into /store/trustedca on first
// run, gated by a config version stamp. This lives in its own small plugin rather
// than inside the abrp bundle so that bundle stays well under the DukTape task
// stack limit (see docs/plugin-repo-hosting.md). It ships its PEM data as a sibling
// `certdata` element and is independent of abrp's telemetry code.
//
// Runtime: OVMS Duktape (ES2015; var + function only, no arrow/template literals).
// On-device it loads as `abrpcerts = require("plugin/abrpcerts/abrpcerts")` and
// self-schedules the install on the first ticker.1 (off the plugin-load stack).
// require()-able off-device (node:test) with no side effects — the ticker
// subscription is guarded on `typeof PubSub`.

// Bump when the trustedca set changes to force a one-time reinstall.
var CERTS_VERSION = 1;

function log(level, msg) {
  if (typeof print === 'function') {
    print('[abrp-certs] ' + level + ': ' + msg + '\n');
  }
}

// Indirection so unit tests can inject fake cert data without resolving the
// external element. On-device this reaches the sibling `certdata` element.
function defaultLoader() {
  return require('plugin/abrpcerts/certdata');
}
var certDataLoader = defaultLoader;

function setCertDataLoader(fn) {
  certDataLoader = fn;
}

// True only while an install is mid-flight, to guard against re-entry.
var inProgress = false;

function bootstrap() {
  if (typeof VFS === 'undefined' ||
      typeof OvmsConfig === 'undefined' ||
      typeof OvmsCommand === 'undefined') {
    return; // host APIs unavailable (off-device / hand-install)
  }
  if (inProgress) {
    return;
  }

  var stamp = Number(OvmsConfig.Get('usr', 'abrp.certs_version', '0'));
  if (stamp >= CERTS_VERSION) {
    return; // up to date — zero I/O
  }

  var certs;
  try {
    certs = certDataLoader();
  } catch (e) {
    log('ERROR', 'cert data unavailable (' + e + ')');
    return;
  }
  if (!certs || !certs.length) {
    log('ERROR', 'cert data empty');
    return;
  }

  inProgress = true;
  var total = certs.length;
  var settled = 0;
  var failed = false;

  function settle() {
    settled += 1;
    if (settled < total) {
      return;
    }
    inProgress = false;
    if (failed) {
      log('ERROR', 'a cert failed to write; will retry next start');
      return;
    }
    try {
      OvmsCommand.Exec('tls trust reload');
    } catch (e2) {
      log('ERROR', 'tls trust reload failed (' + e2 + ')');
      return;
    }
    OvmsConfig.Set('usr', 'abrp.certs_version', String(CERTS_VERSION));
    log('INFO', 'installed ' + total + ' CA root(s)');
  }

  certs.forEach(function (cert) {
    VFS.Save({
      path: '/store/trustedca/' + cert.file,
      data: cert.pem,
      done: function () {
        settle();
      },
      fail: function (err) {
        failed = true;
        log('ERROR', 'failed to write ' + cert.file + ' (' + err + ')');
        settle();
      },
    });
  });
}

// On-device: run once on the first ticker, off the plugin-load stack. Guarded so
// require() is side-effect-free off-device (the node:test suite).
if (typeof PubSub !== 'undefined') {
  var installTok = PubSub.subscribe('ticker.1', function () {
    PubSub.unsubscribe(installTok);
    bootstrap();
  });
}

module.exports = {
  bootstrap: bootstrap,
  CERTS_VERSION: CERTS_VERSION,
  __test: {
    setCertDataLoader: setCertDataLoader,
  },
};
