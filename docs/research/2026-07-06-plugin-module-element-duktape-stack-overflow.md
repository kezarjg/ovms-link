# Bug report: plugin `module` element overflows the "OVMS DukTape" task stack (WDT reboot loop)

> **Revision note (corrected root cause).** An earlier draft attributed the crash to
> the plugin loader's `eval`-wrapper sitting "a few C-stack frames *deeper*" than the
> `ovmsmain` load path. Reading `duk_module_node.c` shows that is the wrong direction:
> the `ovmsmain`/`peval_main` path actually nests the `require()` one module layer
> *deeper* than the plugin path, yet it loads the **identical single 50 KB file**
> without crashing. The true cause is not a structural depth gap between the two entry
> points -- it is that **compiling one ~50 KB source as a single Duktape compilation
> unit very nearly exhausts the whole 12 KB task stack**, and the plugin path happens
> to carry a few hundred bytes more baseline stack at that moment, which is enough to
> cross the line. Both paths are balanced on the same edge. This revision rewrites the
> "Root cause" and "Proposed fixes" sections accordingly. All source-location facts in
> the original were verified accurate and are retained.

> **Update (plugin-install unblocked from the author side).** Since this report was
> written, a delivery-side workaround was found and validated on-device that installs
> and boots this plugin cleanly via `plugin install`. The `module` element is now a
> ~1.4 KB shim; the ~43 KB bundle ships as a separate `webrsc` **data** element (which
> the plugin store does NOT compile at load) and is `require()`d by the shim on the
> first `ticker.1`. That moves the big compile off the deep `LoadEnabledModules` C++
> frame and onto the shallow event-loop (ticker) stack, which is exactly the ~1 KB of
> baseline the plugin path was over by. Measured same-session A/B: the single-bundle
> `module` element peaks at **11968 / 12288** (320 B free) via the plugin loader and
> overflowed unoptimized; the shim + ticker-deferred core peaks at **11184 / 12288
> (1104 B free)**, boots with 0 crashes, and the core loads and streams normally. This
> is a strictly better author-side lever than the source-restructuring one measured
> below (fix #3), because it structurally decouples the big compile from the loader
> depth rather than shaving the compile. **It does not change the underlying finding
> or the asks to maintainers:** the 43 KB compile still consumes ~1.6 KB above the
> ~9.5 KB firmware baseline on the same 12 KB stack, so the robust fix (#1, raise the
> stack) and the fail-safe gap (#2, a C-stack overflow is still an uncatchable WDT
> reboot loop) both stand. The workaround only helps authors who can split delivery
> this way; it does nothing for the crash-recovery experience. See the expanded fix #3
> and the "shim + ticker-deferred core" measurement row below.

## Summary

Installing a plugin whose `module` element is a large (~50 KB) bundled JavaScript
file causes a **stack overflow in the "OVMS DukTape" FreeRTOS task** the moment the
plugin store loads it at boot, which puts the module into an unrecoverable watchdog
reboot loop. The **same single file** loads and runs when hand-copied as a side-load
script (`/store/scripts/lib/...` + `ovmsmain.js require()`), but that only works *by a
small margin* -- the 50 KB compile nearly fills the 12 KB DukTape task stack on both
paths, and the plugin path is the marginally heavier of the two. The problem is a
task stack that is too small for a single large module compilation unit, exposed
first by the plugin loader.

## Environment

- Firmware: `4231131/ota_0/main (build idf 9063c86 Jun 25 2026 00:49:06, product v3.3)`
  (built from `Open-Vehicle-Monitoring-System-3`; the on-device error messages carry
  the matching source paths, e.g. `.../ovms_script/srcduk/ovms_duktape.cpp:541`).
- Hardware: OVMS v3.3, ESP32 (rev ESP32/3), 16 MB flash.
- DukTape task stack: `CONFIG_OVMS_SC_JAVASCRIPT_DUKTAPE_STACK` = **12288 bytes**
  (`main/Kconfig:297`, applied at `components/ovms_script/srcduk/ovms_duktape.cpp:1004`).
- The plugin: a single `module` element `abrp.js` of ~50 KB (a dependency-free
  bundle of ~11 small CommonJS modules concatenated into one self-contained file with
  its own internal `__require`/`__mods` registry -- i.e. **one compilation unit**).
  Plus `webrsc` / `webpage` / `webhook` elements (not implicated).

## Symptom

On `module reset`, the boot reaches the plugin loader and aborts:

```
I (2844) pluginstore: Loading enabled plugins (1)
OVMS>
[OVMS] ***ERROR*** A stack overflow in task OVMS DukTape has been detected.
abort() was called at PC 0x40136aca on core 1

Backtrace: 0x4008dc52 0x4008deed 0x40136aca 0x40090ba4 0x40091ce4 0x40091c9a ...
[OVMS] Current tasks: IDLE0|OVMS DukTape
```

This repeats every boot -> WDT reboot loop. **SSH never comes up** (the crash occurs
before the network stack settles into a usable state), so the only recovery is a USB
serial console: delete the module element file during a boot window:

```
vfs rm /store/plugins/<plugin>/<module>.js
```

After which the module boots cleanly (the loader logs `Plugin <name>: could not be
found on disk` and continues).

## Reproduction

1. Build/host a plugin repo whose `abrp` plugin has a single ~50 KB `module` element.
2. On the module: `plugin repo install ...`, `plugin install abrp`, `module reset`.
3. Observe the stack overflow at `Loading enabled plugins` and the reboot loop.

(A ~5-10 KB module element loads fine; the failure is size/stack dependent -- because
the driver is the depth of the recursive-descent *compile* of one source unit, which
scales with the size/nesting of that single file.)

## Root cause

### Both load paths compile the identical file the identical way

A plugin `module` element and a side-load `require()` both funnel through the same
Node-style module machinery. `OvmsDuktape::DukTapeInit`
(`components/ovms_script/srcduk/ovms_duktape.cpp:1548-1552`) registers
`DukOvmsResolveModule` + `DukOvmsLoadModule` and calls `duk_module_node_init`. Every
`require()` -- plugin or side-load -- therefore runs:

```
require(id)
  -> duk__handle_require            (duk_module_node.c:57)
    -> duk_pcall(load callback)     -> DukOvmsLoadModule reads the file
    -> duk_safe_call(duk__eval_module_source)   (duk_module_node.c:118-127)
      -> duk_compile(DUK_COMPILE_EVAL) of "(function(...){ <file> })"  (duk_module_node.c:231)
```

The `duk_compile` at `duk_module_node.c:231` is a **recursive-descent pass over the
whole 50 KB source**, and it is the same call, on the same source, for both paths.
`DukOvmsLoadModule` (`ovms_duktape.cpp:486-560`) reads `plugin/...` and
`lib/...`/`scripts/...` ids through the identical code. So the *compile that overflows
is byte-for-byte the same in both cases*.

### The two entry points reach that compile at almost the same depth

The original draft's claim that the plugin `eval`-wrapper is "deeper" is incorrect.
Cancelling the shared tail above, the frames each entry point adds *before* reaching
`duk__handle_require` are:

| Path | Frames from task base to the shared `require` tail |
|------|----------------------------------------------------|
| **Side-load** (`ovmsmain`) | `DukTapeInit -> duk_module_node_peval_main -> duk_safe_call -> duk__eval_module_source(ovmsmain) -> duk_call(run ovmsmain body) -> [bytecode executor]` |
| **Plugin element** | `DukTapeInit -> OvmsPluginStore::LoadEnabledModules -> duk_pcall(eval "x = require(...)") -> [bytecode executor]` |

Each side has exactly **one** large frame -- the Duktape bytecode interpreter
(`duk_js_execute_bytecode`), which dominates. The `ovmsmain` path actually wraps its
`require()` inside an *extra* module layer (`peval_main` -> `safe_call` ->
`eval_module_source(ovmsmain)` -> `duk_call`) -- i.e. if anything it is the *deeper*
of the two. The plugin path's distinguishing cost is instead the still-live
**`LoadEnabledModules` C++ activation frame** (`ovms_plugins.cpp:475-543`), which at
the point of `duk_pcompile`/`duk_pcall` (lines 536-538) is holding a parsed
`cJSON *json`, an `OvmsPlugin p` (with its element `std::vector`), the `std::string
cmd`, a `FILE*`, buffers, and the loop iterators.

Net: the two paths reach the 50 KB compile within a few hundred bytes of the *same*
total stack depth. The plugin path is the marginally heavier one.

### Why the same file crashes one way and not the other

Because the compile alone very nearly fills the 12 KB task stack, the outcome is
decided at the margin:

- Side-load path: lands a few hundred bytes *under* the canary -> squeaks through.
- Plugin path: carries the extra `LoadEnabledModules` frame (and a slightly heavier
  executor high-water running the concatenated bundle) -> tips a few hundred bytes
  *over* -> FreeRTOS stack-canary abort.

This is a **razor's-edge failure, not a structural one.** The side-load path is not
"safe" -- a somewhat larger bundle (or deeper syntactic nesting) would overflow it
too. The plugin loader is simply the first consumer to cross a line that a 50 KB
single-unit compile already sits right against.

### It is compile/instantiation, not script execution

A variant whose bundle footer defers all module-graph construction to the first
`ticker.1` (synchronous load compiles the file and defines the internal module
function table, but runs no `require` graph and no startup logic) **still overflows at
the same point**. That is expected: Duktape compiles nested function expressions
eagerly during the outer compile, so the full 50 KB is compiled regardless of when the
runtime graph is built. This confirms the stack hog is **compiling / instantiating the
module source**, inside `require()` itself -- not the module's runtime, and not
something a plugin author can defer *while the bundle is still the compiled `module`
element*.

There is, however, an important corollary the author-side workaround (see the top
"Update" and fix #3) exploits. What cannot be deferred is *when the bundle compiles
relative to its own load*; what *can* be moved is *from which C-stack the compile
runs*. If the bundle is shipped as a `webrsc` **data** element (the plugin store copies
it to disk but never compiles it) and a tiny `module`-element shim `require()`s it from
a `ticker.1` callback, then the 50 KB compile still happens in full -- but now inside a
`require()` invoked from the shallow event-loop stack, not from the deep
`LoadEnabledModules` -> `duk_pcompile` -> `duk_pcall` frame. The compile's own stack
cost is unchanged; it simply no longer stacks on top of the ~1 KB loader frame. That is
the entire ~784 B the deferred-shim variant recovers (11968 -> 11184). Note this is a
*different* maneuver from the failed one above: that one deferred the runtime graph but
kept the bundle as the compiled module element (so the compile stayed on the loader
stack and still overflowed); this one keeps the bundle *uncompiled at load* and relocates
the compile to a shallower stack.

### The backtrace is the panic aftermath

Symbolizing the repeating backtrace frames (xtensa `addr2line` against a matching
build) resolves them to the panic/abort path recursing:
`__assert_func -> _vfiprintf_r -> _lock_acquire_recursive -> multi_heap_malloc ->
xQueueCreateMutex -> lock_init_generic ...`. That is the abort handler trying to
`printf`/`malloc` after the overflow was already detected -- i.e. the visible frames
are the aftermath, not the offending chain (which has unwound by the time FreeRTOS'
stack-canary check fires). The primary event is a genuine task C-stack overflow during
module compilation.

## Proposed fixes (for maintainers)

1. **Increase the DukTape task stack (primary fix).** Raise the default
   `CONFIG_OVMS_SC_JAVASCRIPT_DUKTAPE_STACK` from 12288 to e.g. 16384-20480
   (`main/Kconfig:297`). This is the correct robust lever, because the overflow is
   the recursive-descent compile of a single large unit nearly exhausting the stack --
   independent of which entry point triggers it. Costs a few KB RAM on the JS task.

2. **Fail safe (high value, independent of the above).** The current failure mode -- a
   hard WDT reboot loop recoverable only by deleting the file over USB serial -- is
   severe. Guard the plugin `module` load so a failing element disables that plugin
   instead of crashing the task; and/or load plugins only after networking is up so
   SSH remains available for recovery. Note that `LoadEnabledModules` already wraps the
   eval in `duk_pcompile`/`duk_pcall` and routes errors to `DukOvmsErrorHandler`
   (`ovms_plugins.cpp:538-541`), but a **C-stack overflow is not a catchable Duktape
   error** -- it trips the FreeRTOS canary and aborts the task -- so the guard has to be
   about stack budget (see #4) and/or ordering, not just `pcall` error handling.

3. **Author-side / documentation -- a lever, but a razor-thin one (measured below).**
   Two author-side approaches were tested on-device. *Splitting* into multiple smaller
   compilation units barely helps (**~224 bytes**): each nested `require()` re-adds its
   own `duk__handle_require` + `duk_compile` + `duk_js_execute_bytecode` frames, which
   offset the smaller individual compiles. But *reducing the deepest compile nesting*
   in the largest module (flattening a `switch`/`if`/`forEach`-with-nested-functions
   into a flat data table + top-level functions) recovered **~370 bytes** -- and that was
   **enough to make the real plugin load fit**: the optimized bundle peaks at
   **12048 / 12288 (240 bytes to spare)** loaded via the plugin path, where the
   unoptimized bundle overflowed. So authors *can* restructure their way under the
   limit -- but only just, and only because this firmware's baseline happens to leave
   room (see below). It is not robust: it evaporates if the firmware's own JS baseline
   grows, another sizeable plugin loads, or the bundle grows slightly. Documenting a
   practical `module`-element size/nesting limit is worthwhile, but the durable fix is
   still #1.

   **A better author-side lever (validated, deployed): ship the bundle as a `webrsc`
   data element + a `module` shim that compiles it from a ticker.** Rather than shave
   the compile, relocate it. The `module` element becomes a ~1.4 KB shim that, on the
   first `ticker.1`, does `x = require("plugin/<name>/<name>-core")`; the ~43 KB bundle
   ships as a sibling `webrsc` element (data on disk, never compiled by the loader). The
   big compile then runs from the shallow event-loop stack instead of the deep
   `LoadEnabledModules` frame. Measured same-session A/B (same enabled set, full reboot
   each): single-bundle `module` element **11968 / 12288 (320 B free)**; shim +
   ticker-deferred core **11184 / 12288 (1104 B free)** -- a ~784 B / 3.4x-headroom gain,
   0 crashes, core loads and streams normally. This is more durable than restructuring
   because it removes the ~1 KB loader-frame penalty entirely (the compile no longer
   nests under it), rather than trimming the compile against a fixed ceiling. Caveats
   for documentation: it costs one extra `webrsc` element and a few seconds of startup
   latency (the core is absent until the first tick, so authors must gate any consumers
   on the core being loaded); it still runs the full compile on the same 12 KB stack, so
   a large enough bundle would overflow even the ticker path; and it does nothing for
   fix #2 -- if the deferred compile ever does overflow, it is the same uncatchable WDT
   reboot loop. Net: a real, recommendable delivery pattern for authors today, but not a
   substitute for raising the task stack (#1).

4. **If bumping the whole task stack is undesirable:** compile large modules on a
   larger stack -- temporarily grow the stack around plugin/module compilation, or run
   compilation on a dedicated larger-stack helper task.

> **Explicitly dropped from the earlier draft:** "Load plugin `module` elements via the
> same `duk_module_node` path as `ovmsmain`." That was based on the incorrect premise
> that the `ovmsmain` path is structurally shallower. It is not (it nests `require()`
> one layer deeper), so switching the plugin loader to it would only shift the stack
> high-water by a few hundred bytes onto the same razor's edge -- it would not prevent
> the crash for a bundle at or above this size.

## Severity

High for plugin authors shipping non-trivial `module` elements: the plugin installs
and downloads fine, then bricks the module into a serial-only recovery loop on the
next reboot. It also blocks the documented `plugin install` distribution path for any
single-file bundle near this size. Because the side-load path is only marginally
safer, the practical ceiling for a single compilation unit on the default 12 KB stack
is low and worth raising and/or documenting.

The author-side shim + ticker-deferred-core workaround (top "Update" and fix #3) lowers
the *incidence* for authors who adopt it -- this plugin now installs and boots cleanly
via `plugin install` -- but it does not lower the underlying severity: the failure is
still an uncatchable C-stack overflow that only manifests at boot with no shell, the
workaround is non-obvious and undocumented, and any author who ships a plain large
`module` element (the natural, documented approach) still hits the brick-loop. The
crash-recovery experience (fix #2) is unchanged regardless of the workaround.

## Measured on-device (side-load A/B, no firmware change)

The stack accounting above was **confirmed on-device** with the stock `module tasks`
command (no probe code, no rebuild), reading the `OVMS DukTape` row after a fresh boot.
The crashing plugin variant cannot self-report (it aborts before any shell), so both
variants were measured as **side-loads** (`/store/scripts/lib/...` + `ovmsmain.js
require()`) -- the same compile, on the same task, minus the plugin loader's extra frame.

| Variant (side-loaded, measured at boot) | Compilation units | `Max` (peak) | `Total` | Headroom |
|---|---|---|---|---|
| Single ~50 KB bundle (one `require`) | 1 | **11808** | 12288 | **480 B** |
| Un-bundled: entry + 11 files (largest 10.8 KB) | 11 | **11584** | 12288 | 704 B |

Two empirical conclusions:

- **The razor's-edge is real and tight.** The working side-load peaks at **96% of the
  12 KB stack** -- only 480 bytes free. The plugin path adds the live `LoadEnabledModules`
  frame on top of this same compile, which is more than 480 bytes -> the abort. (`Now`
  idles at 496 bytes; the 11808 peak is set once, early, by the boot-time compile --
  matching the "compile is the stack hog" analysis above.)
- **What moves the peak, and what doesn't.** *Splitting* the single 50 KB unit into 11
  units <= 10.8 KB lowered the peak by only 224 bytes (11808 -> 11584) -- the nested
  `require()`s re-add `duk__handle_require` + `duk_compile` + `duk_js_execute_bytecode`
  frames that offset the smaller compiles. But *cutting the deepest compile nesting* in
  the biggest module (a `switch`/`if`/`forEach` with nested function expressions, flattened
  to a data table + top-level functions) recovered ~370 bytes (11808 -> 11440). **That was
  enough**: the optimized bundle then loaded via the real plugin path at **12048 / 12288 --
  it fit, with 240 bytes to spare**, where the unoptimized bundle overflowed. So author-side
  work *can* get a plugin under the limit, but the margin here is 240 bytes -- it survives
  only because this firmware's baseline leaves room. Raising
  `CONFIG_OVMS_SC_JAVASCRIPT_DUKTAPE_STACK` (fix #1) remains the robust lever; author
  restructuring is a fragile stopgap.

### The stack budget: a high OVMS floor + a heavy per-plugin-load cost

Measuring the `OVMS DukTape` peak with progressively less loaded -- all plugins disabled
and an empty `ovmsmain.js`, then adding one thing at a time, with a full reboot each time
so the task's stack high-water resets -- separates the firmware baseline from the plugin
cost:

| Loaded on the DukTape task (cumulative) | `Max` peak | delta | vs 12288 |
|---|---|---|---|
| **Nothing** (no enabled plugins, empty `ovmsmain.js`) | **9552** | -- | **78%** |
| + a 3.4 KB `module` element (`abrpcerts`), plugin-load path | 10608 | +1056 | 86% |
| + the abrp bundle side-loaded (~44 KB, optimized) | 11440 | +832 | 93% |
| + the abrp bundle side-loaded (~50 KB, unoptimized) | 11808 | +1200 | 96% |
| + the abrp bundle **loaded via the plugin path** (~43 KB, optimized) | **12048** | -- | **98% -- fits, 240 B free** |
| + the abrp bundle via the plugin path (unoptimized) | ~12416 (est.) | -- | **overflow -> WDT loop** |
| + the abrp bundle as a **shim + ticker-deferred `webrsc` core** (plugin path) | **11184** | -- | **91% -- fits, 1104 B free** |

(The last row is the deployed workaround from fix #3: the ~43 KB compile still runs in
full, but from the shallow ticker stack rather than the deep `LoadEnabledModules` frame,
so it lands ~784 B below the single-bundle plugin-path peak and well clear of the canary.
Same enabled set, measured after a full reboot; the core's compile shows up in the peak
because the shim `require()`s it within the first second of `ticker.1`.)

Two things stand out:

1. **OVMS's own JavaScript already uses ~9.5 KB of the 12 KB task stack (78%)** before any
   user code -- leaving ~2.7 KB for everything else.
2. **A 3.4 KB plugin cost ~1 KB of stack** -- not for its content, but for the *load path*.
   Loading a `module` element runs `LoadEnabledModules` ->
   `duk_pcompile(DUK_COMPILE_EVAL)` -> `duk_pcall` from a deep C++ frame, so even a tiny
   module compiles from far down the stack. The per-module load overhead is ~1 KB
   regardless of module size. A larger element (abrp) adds its own compile on top of that
   and crosses the canary; the *same* bundle side-loaded (shallower entry, no
   `LoadEnabledModules` frame) fits.

Net: the overflow is less "this plugin is too big" than **a 12 KB task stack that is 78%
consumed by OVMS itself and then charges ~1 KB just to enter the plugin-load path.** That
is the case for raising `CONFIG_OVMS_SC_JAVASCRIPT_DUKTAPE_STACK`.

(Caveat: the two abrp side-load rows were measured with `abrpcerts` also enabled, so they
read as OVMS + `abrpcerts` + abrp; a fully de-conflated abrp-only-over-9552 figure would
need a separate run. The load-bearing numbers are the **9552 floor** and the **~1 KB
per-plugin-load cost**.)

### A note on plugin lifecycle (secondary)

Related rough edge encountered during recovery: deleting a crashing `module` element's
file from `/store/plugins/<name>/` does **not** clear the plugin's `plugin.enabled`
config flag, and `plugin remove` reports "Not yet implemented". The result is an
orphaned enable that logs `Plugin <name>: could not be found on disk` on every boot
(harmless, but noisy, and it would auto-load-and-recrash if the file ever reappeared).
`plugin disable <name>` clears it. A working `plugin remove`, and clearing the enable
flag when a plugin's files are gone, would make failed installs less messy.

### How to reproduce

`module tasks` (`main/ovms_module.cpp:720`, registered at `:1600`) prints per-task stack:

```
OVMS# module tasks
Number of Tasks = 24     Stack:  Now   Max Total    Heap 32-bit SPIRAM C# PRI CPU% BPR/MH
...
XXXXXXXX   NN R  OVMS DukTape     NNNN  NNNN 12288   ...
                                  ^Now  ^Max ^Total
```

The **Max** column is the peak stack this task has ever used
(`Total - uxTaskGetStackHighWaterMark`); **Total** for `OVMS DukTape` is the 12288-byte
task stack.

Because the plugin `module` variant aborts at boot before any shell is reachable,
measure the **working side-load variant** instead:

1. Copy the same single 50 KB `abrp.js` to `/store/scripts/lib/abrp.js` and add
   `abrp = require("lib/abrp");` to `ovmsmain.js`.
2. `module reset`, let it boot (the compile runs during DukTape init, so the peak is
   set early).
3. Over SSH or the web shell, run `module tasks` and read the `OVMS DukTape` row.

A **Max** within a few hundred bytes of **Total (12288)** confirms both claims at once:
the 50 KB single-unit compile nearly fills the 12 KB stack, and the side-load path
succeeds only by a small margin (hence the same file crashes on the marginally heavier
plugin path). After raising `CONFIG_OVMS_SC_JAVASCRIPT_DUKTAPE_STACK`, re-check the same
row to verify headroom.

(The measurement is available from the plugin/JS side too -- a script may run
`OvmsCommand.Exec("module tasks")` and parse the `OVMS DukTape` row -- but that only
applies to the non-crashing side-load form; the crashing plugin element cannot
self-report.)

## Appendix: exact source locations (Open-Vehicle-Monitoring-System-3) -- all verified

- `components/ovms_plugins/src/ovms_plugins.cpp:475` -- `LoadEnabledModules()`; the
  `name = require("plugin/name/file")` eval via `duk_pcompile(DUK_COMPILE_EVAL)` +
  `duk_pcall` (lines 520-543). This C++ frame is still live during the compile.
- `components/ovms_script/srcduk/ovms_duktape.cpp:1609` -- plugin module load call
  (`MyPluginStore.LoadEnabledModules(EL_MODULE);`), inside `DukTapeInit()`.
- `components/ovms_script/srcduk/ovms_duktape.cpp:1613-1627` -- `ovmsmain.js` load via
  `duk_module_node_peval_main` (the working comparison path), inline in `DukTapeInit()`.
- `components/ovms_script/srcduk/ovms_duktape.cpp:486-560` -- `DukOvmsLoadModule`
  (identical file read for `plugin/` and `lib/`/`scripts/` ids).
- `components/ovms_script/srcduk/ovms_duktape.cpp:1548-1552` -- module-node
  registration (`resolve`/`load` callbacks + `duk_module_node_init`), shared by both
  paths.
- `components/duktape/extras/module-node/duk_module_node.c:57-146` -- `duk__handle_require`;
  `:203-262` -- `duk__eval_module_source` (the `duk_compile` at `:231` is the overflow
  site); `:265-281` -- `duk_module_node_peval_main`.
- `components/ovms_script/srcduk/ovms_duktape.cpp:1004-1006` -- "OVMS DukTape" task
  creation with `CONFIG_OVMS_SC_JAVASCRIPT_DUKTAPE_STACK`.
- `main/Kconfig:295-301` -- `CONFIG_OVMS_SC_JAVASCRIPT_DUKTAPE_STACK`, default 12288.
