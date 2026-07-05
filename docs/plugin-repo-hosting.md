# Hosting the OVMS plugin repository

`publish.js` assembles a static file tree (`npm run release`, or
`node publish.js --out <dir>`) that the OVMS on-device plugin store installs from.
This document describes what an HTTP host must provide to serve that tree so
`plugin repo install` / `plugin install` work on a real module.

> **TL;DR:** serve the tree over **plain HTTP/1.1** from an Apache/nginx origin —
> **not** a CDN, and **not** HTTP/2. That single constraint is the whole reason this
> doc exists.

## The hard requirement: plain HTTP/1.1, no CDN, no HTTP/2

OVMS's HTTP client (mongoose) speaks **HTTP/1.1 only**. Given an HTTP/2 or
CDN-framed response it fails the fetch with:

```
pluginstore: Repo abrp: HTTP response invalid
pluginstore: Plugin repository 'abrp' failed to refresh
```

This is why **GitHub Pages does not work** as a repo host: `*.github.io` is served
over HTTP/2 through a CDN (Fastly), which OVMS cannot parse. It is *not* a TLS/CA
problem — OVMS does HTTPS/1.1 fine; the blocker is HTTP/2.

Therefore the host must:

- **Serve over plain `http://` on port 80.** This is exactly what the built-in
  openvehicles repo does (`http://api.openvehicles.com/plugins/`, Apache/2.4, plain
  HTTP/1.1) — proven to work on-device. Start here.
- **Have no CDN in front** (no Cloudflare / Fastly / etc.). The module must reach
  your origin web server directly.
- **Not force an HTTP→HTTPS redirect** for the repo paths, and issue **no
  cross-host redirects** — OVMS will not follow them.

HTTPS *can* work, but only if the server serves **HTTP/1.1 over TLS with HTTP/2
disabled** and the module trusts the CA. A Let's Encrypt cert is a good candidate
because `isrgrootx1.pem` already ships in this plugin's `trustedca/` set — but plain
HTTP is the zero-risk, proven path. Get plain HTTP working first; treat HTTPS as a
later hardening step.

## URL layout

Choose a base URL, e.g. `http://ovms.kezarnet.com/ovms-plugins/`. Serve the
`publish.js` output tree verbatim under it so these all resolve with `HTTP/1.1 200`:

```
<base>/plugins.rev            repo revision string (OVMS refresh trigger)
<base>/plugins.json           repo index (JSON array of plugin summaries)
<base>/abrp/abrp.json         per-plugin manifest, fetched on install (single object)
<base>/abrp/abrp.js           the bundle (module element)
<base>/abrp/certdata.js       CA roots (webrsc element)
<base>/abrp/config.htm        web config page
<base>/abrp/dashboard.htm     web status page
<base>/abrp/status-hook.htm   status-page hook
```

`<base>` is the URL you pass to `plugin repo install abrp <base>`.

### How OVMS uses these files

- **`plugins.rev`** — a single revision string. OVMS caches it and only re-reads
  `plugins.json` when it *changes*. `publish.js` writes the plugin version here, so
  it advances on every release. Without this file the store can't tell the repo
  changed and refuses to refresh.
- **`plugins.json`** — the repo index, a JSON **array** of plugin summary objects.
- **`abrp/abrp.json`** — the per-plugin manifest OVMS fetches when you install
  `abrp`. It is the **single** plugin object (i.e. `plugins.json[0]`), *not* the
  array. If this file is missing and the server answers with an HTML 404 body, OVMS
  saves that HTML and fails with `could not parse metadata`.

## Server configuration

Do:

- **Return real `404`s for missing files.** Do not substitute a `200` HTML error
  page — a 404 HTML body saved as `abrp.json` is what breaks the install.
- **Serve `.rev` files.** They have no standard MIME type; the default
  `application/octet-stream` is fine (OVMS reads the raw body). Just don't run a
  server that refuses unknown extensions.
- **Keep `plugins.rev` uncached** if any caching layer exists, or new versions
  won't be seen.

Don't: put the paths behind auth, gzip transforms that rewrite framing, or a CDN.

### nginx (plain HTTP/1.1 — note: no `http2`)

```nginx
server {
    listen 80;
    server_name ovms.kezarnet.com;

    location /ovms-plugins/ {
        alias /var/www/ovms-plugins/;   # trailing slashes matter
        autoindex off;
        location = /ovms-plugins/plugins.rev {
            add_header Cache-Control "no-cache";
        }
    }
}
```

### Apache (mirrors the openvehicles setup)

```apache
Alias /ovms-plugins /var/www/ovms-plugins
<Directory /var/www/ovms-plugins>
    Require all granted
    Options -Indexes
</Directory>
# If HTTP/2 is enabled globally, force 1.1 for this vhost:
#   Protocols http/1.1
```

## Deploy

Build the bundle, assemble the tree, and sync it to the docroot:

```bash
npm run build
node publish.js --out ./ovms-plugins
rsync -av ./ovms-plugins/  <user>@ovms.kezarnet.com:/var/www/ovms-plugins/
```

Re-run all three on each new version. `plugins.rev` bumps automatically with the
plugin version, so OVMS picks up the change on its next refresh.

(`npm run release` / `node publish.js --publish` instead pushes the tree to a
`gh-pages` branch — useful as a build artifact, but **gh-pages is not a valid
on-device host** per the HTTP/2 constraint above. Use it only for staging the files,
then serve them from a plain HTTP/1.1 origin.)

## Verify before touching a vehicle

From any machine, confirm HTTP/1.1, `200`s, and that no HTTP/2 or CDN is in play:

```bash
curl -s -D - -o /dev/null http://ovms.kezarnet.com/ovms-plugins/plugins.json
curl -s -D - -o /dev/null http://ovms.kezarnet.com/ovms-plugins/plugins.rev
curl -s http://ovms.kezarnet.com/ovms-plugins/abrp/abrp.json | head -3
```

Every response's first status line must be `HTTP/1.1 200` (not `HTTP/2`), the
`abrp.json` body must be JSON (not HTML), and there should be no CDN headers
(`via:`, `cf-*`, `x-served-by:`).

## Register + install on the module

Only after the `curl` checks pass:

```text
plugin repo install abrp http://ovms.kezarnet.com/ovms-plugins/
plugin install abrp
module reset      # module elements only load on a full reboot, not `script reload`
```

Watch the boot log (`/sd/logs/log.txt`) as it comes back up: you want
`Downloading plugin: abrp` → each `Element: … downloaded ok`, then a clean
`[plugin/abrp/abrp.js]` startup with no `stack overflow` / reboot. (The cert
bootstrap is deferred to the first `ticker.1`, so it runs after load, off the plugin
loader's stack.)
