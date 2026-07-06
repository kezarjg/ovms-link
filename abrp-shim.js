// abrp plugin module element: a thin shim. The real abrp bundle ships as the
// sibling `abrp-core` webrsc element and is require()'d here on the first
// ticker.1, so its large Duktape compile runs from the shallow event-loop stack
// rather than the deep plugin-loader stack (LoadEnabledModules -> duk_pcall ->
// require -> duk_pcompile). Compiling the ~43 KB bundle from that deep stack
// overflows the 12 KB DukTape task stack; deferring the compile to a ticker keeps
// it well under the canary. See docs/plugin-repo-hosting.md.
//
// This shim is ONLY for plugin delivery. The side-load (hand-copy) install uses
// the single bundle directly, which already has enough stack headroom.
//
// Runtime: OVMS Duktape (ES2015; var + function only, no arrow/template literals).
// On-device OVMS loads it as `abrp = require("plugin/abrp/abrp")`; require()-able
// off-device (node:test) with no side effects (the ticker subscription is
// PubSub-guarded), where it exports an empty object until the ticker fires.
if (typeof PubSub !== 'undefined') {
  var abrpCoreTok = PubSub.subscribe('ticker.1', function () {
    PubSub.unsubscribe(abrpCoreTok);
    // Compile + load the real bundle here, on the shallow event-loop stack, and
    // (re)assign the global `abrp` that OVMS set to this shim at load time.
    abrp = require('plugin/abrp/abrp-core');
  });
}

module.exports = {};
