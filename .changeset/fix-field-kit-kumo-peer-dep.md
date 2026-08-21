---
"@emdash-cms/plugin-field-kit": patch
---

Fixes the `@cloudflare/kumo` peer-dependency range to resolve version 2.6.0 alongside the rest of the EmDash monorepo, instead of constraining it to `^1.0.0` and causing npm ERESOLVE conflicts when installing with `emdash@0.30.0`.
