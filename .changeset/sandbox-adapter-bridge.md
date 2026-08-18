---
"@emdash-cms/cloudflare": patch
---

Route the Cloudflare sandbox bridge through the configured database adapter so
sandboxed plugins share the same database as the rest of the site. The bridge
opens a fresh event-scoped connection for each request on connection-backed
adapters such as Hyperdrive.
