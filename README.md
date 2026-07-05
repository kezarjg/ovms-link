# README

[A Better Routeplanner (ABRP)](https://abetterrouteplanner.com) is an electric
vehicle (EV) focussed route planner that incorporates planning of EV charging
stops.

This OVMS plugin sends live telemetry data from the vehicle to ABRP to be used
for the route planning process and appropriate updates to the plan along the way
based on live information.

## Requirements

- **OVMS firmware version**: `3.3.004` or newer  
  This plugin requires features introduced in OVMS firmware version `3.3.004`.

## Installation

### Obtain Live Data Token

1. Register with [A Better Routeplanner (ABRP)](https://abetterrouteplanner.com)
   and login
2. Setup your vehicle, starting with **Select car model**
3. In the settings for the new vehicle, click on the **Live data** button to
   generate a generic token. Keep a record of this token

### Install manually (recommended today)

Build and hand-copy the single-file bundle. This requires
[Node.js](https://nodejs.org) (the bundler is dependency-free, so **no `npm install`
is needed**):

```bash
npm run build      # emits dist/abrp.js
```

1. In the OVMS web console, **Tools** -> **Editor**; use `/store/scripts/lib/abrp.js`
   for **Path**, **Load**, paste the content of the built `dist/abrp.js`, **Save**.
2. Use `/store/scripts/ovmsmain.js` for **Path**, **Load**, paste the content of the
   repository's `ovmsmain.js`, **Save**.

### Install via the OVMS plugin store (self-hosted repo)

The plugin-store install requires the plugin repository to be served from a **plain
HTTP/1.1 host**. GitHub Pages does **not** work — its HTTP/2 / CDN responses are
rejected by OVMS's HTTP client (`HTTP response invalid`). Once you host the repo
(see [docs/plugin-repo-hosting.md](docs/plugin-repo-hosting.md) for the requirements;
`publish.js` / `npm run release` assembles the tree):

1. In the OVMS web console, go to **Tools** -> **Shell**.
2. Register the repository and install (substitute your host):

   ```text
   plugin repo install abrp http://<your-plugin-host>/ovms-plugins/
   plugin install abrp
   module reset
   ```

   Later, `plugin update` upgrades to new versions.

*No `ovmsmain.js` step is needed for this method — the plugin's module element
auto-loads at each JS-engine start. Note module elements only load on a full reboot
(`module reset`), not `script reload`.*

**Runtime TLS certificates.** The plugin's live connection to `api.iternio.com` needs
extra CA roots. The **plugin-store** install ships these as a `certdata` element and
writes them to `/store/trustedca` automatically on first run (gated by a version
stamp). For the **manual** install, add them once yourself using the steps below.

### Install or update the trusted root CA in OVMS

OVMS includes a limited amount of trusted CA. We need to import additional ones for the plugin to work.

1. Login to the
   [OVMS web console](https://docs.openvehicles.com/en/latest/userguide/installation.html#initial-connection-wifi-and-browser)
2. Navigate to the **Tools** -> **Editor** menu item
3. Create a new `trustedca` directory in `/store/` if it does not exist
4. For each certificate file (.crt or .pem) in [trustedca](/trustedca) create a new file in the `/store/trustedca` directory
5. Copy the contents of the certificate file into that file
6. Navigate to the **Tools** -> **Shell** menu item
7. Execute the following message: `tls trust reload`
8. Execute the following message: `tls trust list` to confirm that the new roots are trusted.

More information on the trusted CA can be found in the [trustedca](/trustedca/README.md) folder

### Configure Plugin

1. Navigate to **Tools** -> **Shell** in the OVMS web console
2. In the OVMS shell issue the following command substituting `<token>` with the
   live data generic token that was set up for the vehicle in ABRP

   ```text
   config set usr abrp.user_token <token>
   ```

### Reload the JS Engine

1. Navigate to **Tools** -> **Editor** in the OVMS web console and press the
   **Reload JS Engine** button. This should result in an `ABRP::started`
   notification if the plugin is installed and configured correctly.

## Usage

With the configuration described above the ABRP plugin automatically streams live
telemetry to ABRP while the vehicle is on or charging. It samples the metrics a few
times a second and queues a point only when a value meaningfully changes (a periodic
keep-alive stops the session going idle), so traffic naturally scales with how much
is actually happening. The sampling and send cadence are tunable via the
`usr abrp.sample_interval` (capture) and `usr abrp.send_interval` (flush) config keys.

### OVMS Shell Commands

- `script eval abrp.info()` - display vehicle telemetry that would be sent to
  ABRP
- `script eval abrp.onetime()` - send current telemetry to ABRP once only
- `script eval abrp.send(1)` - start periodically sending telemetry to ABRP
  (when necessary)
- `script eval abrp.send(0)` - stop sending telemetry
- `script eval abrp.resetConfig()` - reset configuration
