---
"@emdash-cms/registry-client": minor
---

Adds typed clients for the experimental delegated release service. `ReleaseServiceClient` submits, polls, and cancels GitHub OpenID Connect release intents, and manages publisher workload policies and retained delegation through a publisher session. `ReleaseServiceOperatorClient` exposes the Cloudflare Access status, pause, suspension, revocation, cancellation, and reconciliation operations.

Both clients validate response envelopes and return stable `ReleaseServiceError` codes with retry metadata. Mutation helpers require idempotency keys, and workload polling requests a fresh token from the configured provider for each call.
