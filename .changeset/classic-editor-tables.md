---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes Classic-editor table import so `<table>` elements are converted to Portable Text `table` blocks instead of being flattened into a paragraph.

Classic posts that contain raw HTML tables now preserve rows, cells, and inline formatting such as links and bold text. Header rows are detected from `<th>` cells, and tables used as image-plus-caption wrappers (where the table contains an `<img>`) fall back to image and paragraph handling so the image is not dropped.
