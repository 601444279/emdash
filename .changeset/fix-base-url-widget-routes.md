---
"emdash": patch
---

Fixes built-in widget and SEO route URLs to respect an Astro `base` path.

Categories, Tags, Search, Archives, and Recent Posts widgets now emit links and form actions under the configured base instead of the domain root. The injected `sitemap.xml`, `sitemap-[collection].xml`, and `robots.txt` routes also include the base path when referencing child sitemaps and the sitemap index.
