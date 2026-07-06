# Hosting the OVMS plugin repository

`publish.js` assembles a static file tree (`npm run release`, or
`node publish.js --out <dir>`) that the OVMS on-device plugin store installs from.
This document describes what an HTTP host must provide to serve that tree so
`plugin repo install` / `plugin install` work on a real module.

> **TL;DR:** serve the tree from a *dumb static file server* (Apache/nginx) over
> **plaintext `http://` on port 80**, with real `Content-Length` headers and **no**
> CDN, chunked encoding, HTTPS, or redirects. The plugin store's HTTP client is a
> minimal HTTP/1.0 plaintext client (details below); that is the whole reason this
> doc exists. **HTTPS and GitHub Pages cannot serve the module directly** — see the
> "Why not GitHub / HTTPS" subsection below.

## The hard requirement: what the plugin store's HTTP client can (and can't) do

The constraint comes from the specific client the plugin store fetches with. It is
**not** mongoose, and **not** the TLS-capable `HTTP` global that abrp's own telemetry
uses. The store calls `OvmsHttpClient` (`components/ovms_http/src/ovms_http.cpp`) once
per element, in `OvmsPluginStore`'s download loop (`components/ovms_plugins/src/ovms_plugins.cpp`).
That client is a minimal raw-TCP HTTP/1.0 implementation, and reading its source pins
down exactly what the origin must provide. Any violation surfaces on-device as:

```
pluginstore: Repo abrp: HTTP response invalid
pluginstore: Plugin repository 'abrp' failed to refresh
```

**1. Plaintext `http://` only — no TLS, so HTTPS is impossible here.**
`OvmsHttpClient::Request()` recognizes an `https://` prefix but merely *strips* it,
then opens a **plain TCP** `OvmsNetTcpConnection` (defaulting to **port 80** unless a
port is in the URL) and writes a cleartext request. There is no mbedTLS handshake
anywhere in the path. Point it at `https://` and it either connects plaintext to :80
or (with `:443`) speaks plaintext at a TLS port and is rejected. Note the asymmetry:
the JavaScript `HTTP` global *does* do TLS (that is how abrp reaches
`api.iternio.com`, and why `abrpcerts` installs CA roots) — but the plugin store does
not use that path.

**2. A correct `Content-Length` — no chunked transfer-encoding.**
`GetBodyAsString()` reads the `Content-Length` header into `expected`, streams the
body to EOF, then:

```c
if (filesize != expected) { ESP_LOGE(TAG, "...does not match expected..."); body.clear(); }
```

A response with **no `Content-Length`** — i.e. `Transfer-Encoding: chunked`, which
CDNs and many app servers emit — leaves `expected == 0`, so the size check fails and
the **entire download is discarded**. There is no chunked decoder. This is the
constraint that rules out "plain HTTP *through a CDN*": even over port 80, a chunked
response fails.

**3. No redirects.** The client has zero `301`/`302`/`Location:` handling. An
`http -> https` upgrade redirect, or any cross-host redirect, is not followed — the
body becomes the redirect page, the size check fails, and the fetch errors.

It also speaks **HTTP/1.0** (`"... HTTP/1.0\r\nHost: ..."`), so it never negotiates
HTTP/2 and relies on `Connection: close` framing.

**Net:** the origin must be a *dumb static file server* — plaintext HTTP on port 80,
real `Content-Length`, no chunked encoding, no CDN, no redirects. That is exactly what
the built-in openvehicles repo is (`http://api.openvehicles.com/plugins/`, Apache/2.4
serving static files, proven on-device) and what our nginx origin is. Start there.

### Why not GitHub (Pages / raw / releases) — and why HTTPS is off the table

GitHub fails this client on every axis at once: it **forces HTTPS** (breaks #1), serves
through **Fastly with HTTP/2 and chunked/compressed bodies** (breaks #2), and
**301-redirects `http -> https`** (breaks #3). A custom-domain Pages site with "Enforce
HTTPS" disabled still terminates on the CDN and returns chunked responses, so it fails
#2 even if you dodge #1 and #3. There is no GitHub surface that serves plaintext
HTTP/1.x with a fixed `Content-Length` and no redirect, so **GitHub cannot be the
origin the module fetches from.** (Earlier notes blaming only HTTP/2, or suggesting
"HTTPS works if you disable HTTP/2," were incorrect: the plugin-store client has no TLS
and no chunked support at all.)

This is why the repo is **sourced and CI-published from GitHub** but **served to
modules from a small plaintext-HTTP origin** (the K3s nginx pod). GitHub is the host of
record — repo, `publish.js`, tag-triggered publish workflow; the nginx pod is just a
protocol adapter for the firmware's crude client. The only thing that would let a
module fetch directly from GitHub (and retire the nginx hop) is a **firmware change**:
the plugin store adopting the same `esp-http-client` + mbedTLS path (TLS + chunked +
redirects) that the JS `HTTP` global already uses. That is the same
"pluginstore-HTTP-handling-is-primitive" theme as the DukTape stack-overflow report
(`docs/research/2026-07-06-plugin-module-element-duktape-stack-overflow.md`).
**Whether to pursue that upstream is deferred** — this section is only the record of
why the GitHub-source / plaintext-origin split exists.

> Firmware source refs (verified against the local checkout): `OvmsHttpClient::Request()`
> — scheme strip, plaintext `Connect()`, HTTP/1.0 request; `OvmsHttpClient::GetBodyAsString()`
> — the `Content-Length` mismatch -> `body.clear()`; both in
> `components/ovms_http/src/ovms_http.cpp`. The per-element fetch loop is in
> `components/ovms_plugins/src/ovms_plugins.cpp`.

## URL layout

Choose a base URL, e.g. `http://ovms.kezarnet.com/plugins/`. Serve the
`publish.js` output tree verbatim under it so these all resolve with `HTTP/1.1 200`:

This repo ships **three** plugins (`publish.js` `buildManifest`): `abrp` (the
telemetry bundle), `abrpweb` (the web UI), and `abrpcerts` (the CA-root installer) —
split so the abrp `module` element stays under the DukTape task-stack limit (see the
stack-overflow research doc). The tree is served verbatim under the base URL, so these
all resolve with `HTTP/1.1 200`:

```
<base>/plugins.rev                 repo revision string (OVMS refresh trigger)
<base>/plugins.json                repo index (JSON array of all three plugin summaries)

<base>/abrp/abrp.json              per-plugin manifest, fetched on install (single object)
<base>/abrp/abrp.js                the shim (module element)
<base>/abrp/abrp-core.js           the real bundle (webrsc, require()d by the shim on ticker.1)

<base>/abrpweb/abrpweb.json        per-plugin manifest
<base>/abrpweb/abrpweb.js          web-UI backend (module element)
<base>/abrpweb/config.htm          web config page
<base>/abrpweb/dashboard.htm       web status page
<base>/abrpweb/status-hook.htm     status-page hook

<base>/abrpcerts/abrpcerts.json    per-plugin manifest
<base>/abrpcerts/abrpcerts.js      CA-root installer (module element)
<base>/abrpcerts/certdata.js       CA roots (webrsc element)
```

`<base>` is the URL you pass to `plugin repo install <base>` (the whole repo);
individual plugins are then installed by name (`plugin install abrp`, etc.).

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

    location /plugins/ {
        alias /var/www/plugins/;   # trailing slashes matter
        autoindex off;
        location = /plugins/plugins.rev {
            add_header Cache-Control "no-cache";
        }
    }
}
```

### Apache (mirrors the openvehicles setup)

```apache
Alias /plugins /var/www/plugins
<Directory /var/www/plugins>
    Require all granted
    Options -Indexes
</Directory>
# If HTTP/2 is enabled globally, force 1.1 for this vhost:
#   Protocols http/1.1
```

## Deploy

The live host is an **nginx pod on the Slate Hill K3s cluster** (namespace `ovms`),
fronted by Traefik on plain HTTP/1.1 at `http://ovms.kezarnet.com/plugins/`. The
plugin tree is a build artifact — it is **not** committed anywhere; you push it
into the pod's docroot with `kubectl cp` (the K3s equivalent of rsync-to-docroot).

Build the bundle, assemble the tree, and copy it in. The `--out` directory name
becomes the URL path segment, so call it `plugins`:

```bash
npm run build && node publish.js --out /tmp/plugins
POD=$(kubectl get pod -n ovms -l app=ovms-plugins --context sh-k3s -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n ovms "$POD" --context sh-k3s -- rm -rf /usr/share/nginx/html/plugins
kubectl cp /tmp/plugins "ovms/$POD:/usr/share/nginx/html/" --context sh-k3s
```

Re-run on each new version. `plugins.rev` bumps automatically with the plugin
version, so OVMS picks up the change on its next refresh. The `rm -rf` before the
copy clears any files that a later release dropped.

Then run the [Verify](#verify-before-touching-a-vehicle) curls (from an off-network
host — the module reaches this over the WAN) before touching the car.

> **Host-side setup lives in the infrastructure repo**, not here: the nginx
> Deployment, PVC, Traefik IngressRoute, and the `web`-entrypoint redirect change
> that lets `/plugins/` be served in plain HTTP/1.1 are under
> `slate-hill/configs/k3s/ovms-server/ovms-plugins/` (see its `README.md`). This
> section only covers pushing new plugin content to an already-running host.

(`npm run release` / `node publish.js --publish` instead pushes the tree to a
`gh-pages` branch. That is fine as a build artifact, but **gh-pages is not a valid
on-device host** — GitHub serves it over HTTPS + HTTP/2 + chunked bodies through a
CDN, none of which the plugin-store client can handle (see "The hard requirement"
section above). Use `--out` + `kubectl cp` for the real host.)

## Automated publishing (GitHub Actions)

`.github/workflows/publish-plugin-repo.yml` runs the build → assemble → `kubectl cp`
flow above automatically. It triggers on a version tag push (`v*`) — the intended
release path, since `plugins.rev == VERSION` and re-serving without a bump is a no-op
for the module — or a manual run from the Actions tab. It gates on `npm test`, checks
the tag matches `VERSION`, publishes to the PVC, and verifies the served rev.

Because the K3s API (`10.20.5.20:6443`) is on a private network, the job runs on a
**self-hosted runner** inside that network. One-time setup:

**1. Self-hosted runner.** Provided by the `ovms-link-publish` **ARC** scale set on
the Slate Hill K3s cluster (`runs-on: ovms-link-publish`), managed in the
infrastructure repo at `slate-hill/configs/k3s/arc/ovms-link-runner-set-values.yaml`.
Its image bakes in `kubectl`; Node is provided per-job by `setup-node` from `.nvmrc`.
(One-time: install the shared `ovms-modern-arc` GitHub App on this repo.)

**2. Scoped ServiceAccount + RBAC.** Now applied and version-controlled in the
infrastructure repo at `slate-hill/configs/k3s/ovms-server/ovms-plugins/publish-rbac.yaml`
(the live SA is named **`plugin-publisher`**, not the placeholder below). `kubectl cp`
is `tar` piped over `exec`, so the deployer only needs `pods` read + `pods/exec` in
namespace `ovms` — not cluster-admin. The shape:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: ovms-plugins-deployer, namespace: ovms }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: ovms-plugins-deployer, namespace: ovms }
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ovms-plugins-deployer, namespace: ovms }
subjects:
  - { kind: ServiceAccount, name: ovms-plugins-deployer, namespace: ovms }
roleRef: { kind: Role, name: ovms-plugins-deployer, apiGroup: rbac.authorization.k8s.io }
---
# k8s 1.24+ does not auto-create SA token secrets; request a long-lived one:
apiVersion: v1
kind: Secret
metadata:
  name: ovms-plugins-deployer-token
  namespace: ovms
  annotations: { kubernetes.io/service-account.name: ovms-plugins-deployer }
type: kubernetes.io/service-account-token
```

**3. `OVMS_KUBECONFIG` repo secret.** Build a kubeconfig that authenticates as the
ServiceAccount above, then base64 it into the secret (the workflow `base64 -d`s it):

```bash
NS=ovms SA=ovms-plugins-deployer
SERVER=https://10.20.5.20:6443
TOKEN=$(kubectl -n $NS get secret ${SA}-token -o jsonpath='{.data.token}' | base64 -d)
CA=$(kubectl -n $NS get secret ${SA}-token -o jsonpath='{.data.ca\.crt}')   # already base64

cat > kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
- name: sh-k3s
  cluster: { server: ${SERVER}, certificate-authority-data: ${CA} }
contexts:
- name: deployer
  context: { cluster: sh-k3s, namespace: ${NS}, user: deployer }
current-context: deployer
users:
- name: deployer
  user: { token: ${TOKEN} }
EOF

base64 -w0 kubeconfig   # paste output into the OVMS_KUBECONFIG repo secret, then: rm kubeconfig
```

To publish thereafter: bump `VERSION` in `lib/abrp/constants.js`, commit, then
`git tag v<VERSION> && git push --tags` — the workflow does the rest. The manual
`kubectl cp` flow above remains available as a fallback.

## Verify before touching a vehicle

From any machine, confirm HTTP/1.1, `200`s, and that no HTTP/2 or CDN is in play:

```bash
curl -s -D - -o /dev/null http://ovms.kezarnet.com/plugins/plugins.json
curl -s -D - -o /dev/null http://ovms.kezarnet.com/plugins/plugins.rev
curl -s http://ovms.kezarnet.com/plugins/abrp/abrp.json | head -3
```

Every response's first status line must be `HTTP/1.1 200` (not `HTTP/2`), the
`abrp.json` body must be JSON (not HTML), and there should be no CDN headers
(`via:`, `cf-*`, `x-served-by:`).

## Register + install on the module

Only after the `curl` checks pass:

```text
plugin repo install abrp http://ovms.kezarnet.com/plugins/
plugin install abrp
module reset      # module elements only load on a full reboot, not `script reload`
```

Watch the boot log (`/sd/logs/log.txt`) as it comes back up: you want
`Downloading plugin: abrp` → each `Element: … downloaded ok`, then a clean boot with
no `stack overflow` / reboot. The abrp `module` element is a thin shim (`abrp.js`); the
real bundle ships as the `abrp-core.js` `webrsc` and is `require()`d on the first
`ticker.1`, so the startup logs you're waiting for come from `[plugin/abrp/abrp-core.js]`
a second or two after load (this deferral is what keeps the big compile off the plugin
loader's stack — see the stack-overflow research doc). CA-root installation is a
separate plugin now (`abrpcerts`), not part of the abrp boot.
