---
"emdash": patch
---

Fixes the visual editing toolbar's image popover so media uploads and library browsing read the response from the standard `{ success, data }` envelope instead of the raw top-level JSON.

Previously, after a successful upload, the toolbar checked `data.item` on the unwrapped response and threw "Upload failed", and the media browser read `data.items`, so it always showed "No images found". Both sites now unwrap `data.data` first while still accepting a bare payload for backwards compatibility.
