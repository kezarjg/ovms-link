# Certificate as of 2024-11-20

When api.iternio.com changes CDN provider or reverse proxy configuration we need to import new trusted root CA in OVMS.

## Cloudflare

`api.iternio.com` is currently behind Cloudflare.

List of Cloudflare issuing authorities: https://developers.cloudflare.com/ssl/reference/certificate-authorities

Currently the Cloudflare certificates can be issued either by Let's Encrypt or Google Trust Services

### Let's Encrypt

Chain of trust https://letsencrypt.org/certificates/

Source for isrgrootx1.pem file : https://letsencrypt.org/certs/isrg-root-x1-cross-signed.pem

### Google Trust Services

Chain of trust https://pki.goog/repository/

Since all Google root CA are cross-signed by GlobalSign it makes more sense to import the GlobalSign certificate.

Source for root-r1.crt file : http://secure.globalsign.com/cacert/root-r1.crt

https://valid.r1.roots.globalsign.com/


