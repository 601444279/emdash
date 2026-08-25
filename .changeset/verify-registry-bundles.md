---
"emdash": patch
"@emdash-cms/registry-client": minor
---

Adds `DirectPdsClient` for reading package profiles and releases with AT Protocol repository proofs, and updates experimental decentralized registry installs and updates to verify current signed records directly from the publisher's PDS.

The installer applies the signed profile's release policy and binds moderation labels to the exact profile or release CID. Artifact checksums, archive paths, bundle limits, manifest identity, and version use the same verification rules as the registry release tooling.

Release records must contain a lowercase base32 multibase `sha2-256` multihash. Existing releases produced by the EmDash plugin CLI already use this format; nonconforming bare hexadecimal checksums are rejected.
