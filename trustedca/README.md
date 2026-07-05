# Trusted CA roots for the ABRP plugin

The plugin's TLS connection to `api.iternio.com` needs the connection's CA root to
be trusted by OVMS. OVMS trusts a fixed set of roots compiled into the firmware,
plus any extra roots dropped into `/store/trustedca` (via `tls trust reload`). The
files here are the *extra* roots - installed by the `abrpcerts` plugin (or by hand;
see the README install steps) on top of the firmware defaults.

`api.iternio.com` sits behind a CDN / reverse proxy whose issuing CA **changes over
time** (it has flip-flopped between Cloudflare - Let's Encrypt or Google Trust
Services - and GoDaddy, and is currently on AWS/Amazon). So we ship the roots for
the CAs it has used that the firmware does **not** already include, as insurance
against the next rotation.

## What OVMS already trusts by default (do not re-ship these)

OVMS compiles these 7 roots into the firmware and trusts them at boot
(`components/ovms_tls/src/ovms_tls.cpp`, verify on-device with `tls trust list`):

| Root | In firmware since |
|---|---|
| USERTrust RSA, DigiCert Global Root CA, DigiCert Global Root G2, Baltimore CyberTrust, Starfield **Class 2** | <= 2020 |
| **ISRG Root X1** (Let's Encrypt) | 2021 |
| **Amazon Root CA 1** | **2026-04-18 - first shipped in release 3.3.006** |

Release tag dates for reference: **3.3.004 = 2024-03-23**, **3.3.005 = 2025-07-18**,
**3.3.006 = 2026-05-17**. So 3.3.004 and 3.3.005 have ISRG Root X1 but **not** Amazon
Root CA 1; 3.3.006 is the first with the Amazon root.

## What `api.iternio.com` needs now, and why we ship each file

Its current live chain roots at **Amazon Root CA 1**:

```
iternio.com  ->  Amazon RSA 2048 M01  ->  Amazon Root CA 1  (cross-signed by Starfield Services Root G2)
```

- **On 3.3.006+** the firmware already trusts Amazon Root CA 1, so the current chain
  validates **with none of these files**.
- **On 3.3.004 / 3.3.005** it does **not** - there's no Amazon Root CA 1, and the
  firmware's *Starfield Class 2* is a different root from the *Starfield Services Root
  G2* cross-signer in the chain - so `amazon.pem` is required there.

| File | Subject | Firmware has it? | Why we ship it |
|---|---|---|---|
| `amazon.pem` | Amazon RSA 2048 M01 (intermediate) | Root only, and only >= 3.3.006 | Covers the current AWS chain on 3.3.004/005 |
| `gdroot-g2.crt` | Go Daddy Root G2 | No | Insurance if iternio rotates back to GoDaddy |
| `root-r1.crt` | GlobalSign Root CA (Google Trust cross-signs to it) | No | Insurance if iternio rotates to Google Trust Services |

**Dropped:** `isrgrootx1.pem` (ISRG Root X1 / Let's Encrypt) - it is in the firmware
default set (since 2021), so shipping our own copy was a pure duplicate. If iternio
returns to a Let's Encrypt cert, the firmware already covers it.

> Note: on 3.3.006+, the current endpoint needs none of these - the `abrpcerts`
> plugin / manual cert step is then only rotation insurance. On 3.3.004/005 it is
> genuinely required for the current AWS chain. (The plugin manifest sets
> `ovms>=3.3.004`; raising it to `3.3.006` would let us lean entirely on the firmware
> Amazon root for the current chain.)

## Sources

- GoDaddy (`gdroot-g2.crt`): https://certs.godaddy.com/repository/gdroot-g2.crt
  (chain: https://certs.godaddy.com/repository)
- Google Trust Services / GlobalSign (`root-r1.crt`):
  http://secure.globalsign.com/cacert/root-r1.crt (all Google roots cross-sign to
  GlobalSign, so importing GlobalSign covers Google; chain: https://pki.goog/repository/)
- Amazon (`amazon.pem`): the AWS ACM issuing intermediate, from the live chain.
- Cloudflare issuing authorities:
  https://developers.cloudflare.com/ssl/reference/certificate-authorities

# Changelog

* 2026-07-05: Dropped isrgrootx1.pem (already a firmware default since 2021).
  Documented the firmware default CA set + per-version coverage; api.iternio.com now
  on AWS/Amazon (Amazon Root CA 1, a firmware default since 3.3.006).
* 2025-02-22: GoDaddy
* 2024-11-20: Cloudflare
* 2024-02-06: GoDaddy
* 2024-04-27: Google Ca
* 2023-01-02: Baltimore CyberTrust
