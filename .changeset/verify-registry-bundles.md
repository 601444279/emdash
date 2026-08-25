---
"emdash": patch
---

Fixes experimental decentralized registry installs and updates so artifact checksums, archive paths, bundle limits, manifest identity, and version use the same verification rules as the registry release tooling.

Release records must contain a lowercase base32 multibase `sha2-256` multihash. Existing releases produced by the EmDash plugin CLI already use this format; nonconforming bare hexadecimal checksums are rejected.
