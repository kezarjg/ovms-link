// CA-certificate bootstrap: at first run, write the curated CA roots into
// /store/trustedca and run `tls trust reload`, gated by a config version stamp.
// Owns its own one-time state. Self-guards to a no-op when the host file/command
// APIs are absent (off-device, hand-install). Carries no PEM bytes — the cert
// data ships as a separate plugin element loaded via the host require.
var C = require('./constants')
var U = require('./util')
var Logger = U.Logger

// True only while an install is mid-flight, to guard against re-entry.
var inProgress = false

// Indirection so unit tests can inject fake cert data without resolving the
// external module. On-device this reaches the second plugin element through the
// host require (build.js defers unknown ids to it).
function defaultLoader() {
  return require('plugin/abrp/certdata')
}
var certDataLoader = defaultLoader

function setCertDataLoader(fn) {
  certDataLoader = fn
}

function bootstrap() {
  if (typeof VFS === 'undefined' ||
      typeof OvmsConfig === 'undefined' ||
      typeof OvmsCommand === 'undefined') {
    return // host APIs unavailable (off-device / hand-install)
  }
  if (inProgress) {
    return
  }

  var stamp = Number(OvmsConfig.Get('usr', 'abrp.certs_version', '0'));
  if (stamp >= C.CERTS_VERSION) {
    return // up to date — zero I/O
  }

  var certs;
  try {
    certs = certDataLoader();
  } catch (e) {
    Logger.error('Cert bootstrap: cert data unavailable (' + e + ')');
    return;
  }
  if (!certs || !certs.length) {
    Logger.error('Cert bootstrap: cert data empty');
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
      Logger.error('Cert bootstrap: a cert failed to write; will retry next start');
      return;
    }
    try {
      OvmsCommand.Exec('tls trust reload');
    } catch (e2) {
      Logger.error('Cert bootstrap: tls trust reload failed (' + e2 + ')');
      return;
    }
    OvmsConfig.Set('usr', 'abrp.certs_version', String(C.CERTS_VERSION));
    Logger.info('Cert bootstrap: installed ' + total + ' CA root(s)');
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
        Logger.error('Cert bootstrap: failed to write ' + cert.file + ' (' + err + ')');
        settle();
      },
    });
  });
}

module.exports = {
  bootstrap: bootstrap,
  __test: {
    setCertDataLoader: setCertDataLoader,
  },
};
