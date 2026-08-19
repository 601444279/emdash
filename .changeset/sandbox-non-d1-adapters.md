---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes sandboxed plugins on Hyperdrive and Durable Objects SQL adapters by routing the Cloudflare `PluginBridge` through the configured database descriptor. Sandboxed plugins now read and write the same database as the rest of the site and no longer require a `DB` D1 binding.
