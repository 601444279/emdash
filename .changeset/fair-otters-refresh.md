---
"@emdash-cms/plugin-cli": patch
---

Fixes saved OAuth sessions failing to refresh or revoke after the original loopback callback server closes. New logins retain the loopback client registration needed to recreate the same OAuth client.

Sessions created before this fix do not contain that registration metadata. Sign in again before their access token expires.

The `pds-conformance` resume phase now forces refresh, so provider conformance runs can prove refresh immediately instead of waiting for access-token expiry.
