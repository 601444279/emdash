---
"emdash": patch
---

Fixes stale edge caching for chrome subsystems (site settings, menus, taxonomies, and widget areas) by invalidating Workers cache tags on every admin write.

- Settings, menu, taxonomy, and widget-area write routes now call `cache.invalidate()` with stable chrome tags (`emdash:settings`, `emdash:menu:<name>`, `emdash:taxonomy:<name>`, `emdash:widget-area:<name>`) after successful mutations.
- Adds cache-hint read helpers (`getSiteSettingsWithCacheHint`, `getMenuWithCacheHint`, `getTaxonomyTermsWithCacheHint`, `getWidgetAreaWithCacheHint`, `getWidgetAreasWithCacheHint`) so public pages can tag themselves precisely for edge invalidation without breaking existing callers.
- Adds shared chrome cache tag helpers in `src/cache/chrome-tags.ts`.
