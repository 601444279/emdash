---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds cropping for JPEG, PNG, and WebP images stored by EmDash on local disk, Cloudflare R2, or S3-compatible storage.

**Duplicate and crop** creates a separate media item. **Crop original** replaces the existing item under the same ID and URL, so every reference uses the cropped image without rewriting or republishing content. The original bytes and crop history are not retained. Existing browser or content delivery network caches may continue to show the uncropped image until they expire or are purged separately.
