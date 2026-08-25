---
"emdash": patch
---

Fixes byline-only collection filters so they drive the listing from the byline credit pivot instead of scanning every entry in the collection.

On large collections this changes the read count from the full collection size to the number of credits matching the byline. A new database index on `_emdash_content_bylines(byline_id, collection_slug, content_id)` ensures the planner can seek the selective byline directly on SQLite and D1.
