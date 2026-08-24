# Delegated release service G0 PDS conformance

Status: Prepared; real-account authorization pending

Companion design: [RFC PR #1870](https://github.com/emdash-cms/emdash/pull/1870)

## Outcome

G0 establishes whether the delegated release service can hold the exact authority defined by the protocol on the first supported PDS implementations. The initial matrix covers Bluesky-hosted PDS and Cirrus.

Each provider must prove that the exact delegated scope:

- creates a record in the active package-release collection;
- reads the created record through the public read path;
- cannot update or delete the release;
- cannot create a package profile;
- cannot create a record in an unrelated collection;
- refreshes through the confidential-client session as documented;
- responds to explicit revocation as documented; and
- stops refreshing sessions bound to a removed confidential-client key.

No result permits a fallback to `transition:generic` or another broad scope.

## Test accounts

Dedicated test accounts are available for:

- Bluesky-hosted PDS; and
- Cirrus.

Keep account handles, recovery material, OAuth state, DPoP keys, access tokens, refresh tokens, and client assertion private keys outside the repository. The evidence report contains the account DID, PDS URL, requested and returned scopes, token expiry metadata, probe results, and public release URI/CID. These values do not grant account access.

Use only dedicated conformance accounts. A successful create-only test intentionally leaves a release record behind because deleting it must be denied.

## Harness surfaces

`@emdash-cms/registry-client/conformance` exports `runPdsScopeConformance()`. The caller supplies an authenticated AT Protocol handler. The same probe runner is used by:

- the loopback public-client preflight in `emdash-plugin pds-conformance`; and
- the release service's confidential-client conformance route when that client is deployed.

The probe runner records a 4xx response as an expected denial. A network error or 5xx response is an inconclusive error and fails the run. A successful forbidden operation fails the run.

The CLI never retries the exact scope with `transition:generic`.

## Prepare the workspace

Build the CLI and its workspace dependencies before running a real account:

```sh
pnpm --filter @emdash-cms/plugin-cli... build
```

Create a private evidence directory outside the repository. The following examples use placeholders; replace them with explicit absolute paths:

```sh
mkdir -m 700 <private-evidence-dir>
```

The CLI defaults OAuth state to `~/.emdash/pds-conformance/<provider>`. Pass `--state-dir` when the test requires a separate disposable location.

## Phase 1: exact-scope authorization

Run the command with the account handle. The browser consent screen must show only the active release collection's create authority.

The Bluesky preflight uses the following command:

```sh
node packages/plugin-cli/dist/index.mjs pds-conformance \
	<bluesky-account-handle> \
	--provider bluesky \
	--phase authorize \
	--state-dir <private-evidence-dir>/bluesky-oauth \
	--output <private-evidence-dir>/bluesky-authorize.json
```

The Cirrus preflight uses the following command:

```sh
node packages/plugin-cli/dist/index.mjs pds-conformance \
	<cirrus-account-handle> \
	--provider cirrus \
	--phase authorize \
	--state-dir <private-evidence-dir>/cirrus-oauth \
	--output <private-evidence-dir>/cirrus-authorize.json
```

Review the generated report. `probes.passed` must be `true`, and the returned stored scope must equal the requested exact scope. Record the emitted DID for later phases.

The authorization phase proves granular scope enforcement through an AT Protocol loopback public client. It does not prove confidential-client assertion, refresh, or client-key behavior.

## Phase 2: refresh observation

Wait until the `oauth.after.expiresAt` value from the authorization report has passed. Run the resume phase with the DID, not the handle:

```sh
node packages/plugin-cli/dist/index.mjs pds-conformance \
	<account-did> \
	--provider <bluesky-or-cirrus> \
	--phase resume \
	--state-dir <private-evidence-dir>/<provider>-oauth \
	--output <private-evidence-dir>/<provider>-refresh.json
```

The command restores the stored exact-scope session, performs a new release create and denial matrix, then reads the non-secret stored-session metadata again. When the previous access token was expired, `oauth.refreshDue` and `oauth.refreshObserved` must both be `true`.

If `refreshDue` is `false`, the run proves session restoration but not refresh. Repeat after the reported expiry.

## Phase 3: explicit revocation observation

Run revocation with the DID:

```sh
node packages/plugin-cli/dist/index.mjs pds-conformance \
	<account-did> \
	--provider <bluesky-or-cirrus> \
	--phase revoke \
	--state-dir <private-evidence-dir>/<provider>-oauth \
	--output <private-evidence-dir>/<provider>-revoke.json
```

The command requires the authorization server's revocation request to complete, removes local session state, and records immediate post-revocation access-token behavior. Immediate access denial is desirable but is not required by the protocol: an already-issued access token may remain valid until expiry. The report therefore treats the post-revocation probes as observation rather than the ordinary scope verdict.

The account must reauthorize before another test cycle.

## Confidential-client conformance

G0 does not close on loopback-client evidence. The release service must repeat the same probes through its real confidential client:

1. Deploy the client metadata and JWKS endpoints on the service's HTTPS origin.
2. Configure `private_key_jwt` with an active assertion key and one overlapping previous public key.
3. Complete delegation through the service callback using the exact scope.
4. Call `runPdsScopeConformance()` with the restored confidential session handler.
5. Wait for access-token expiry and prove refresh through the retained session.
6. Call the authorization server's revocation endpoint and record immediate and post-expiry behavior.
7. Reauthorize using the previous assertion key, rotate the active key, retain the previous public key, and prove refresh still works.
8. Remove the previous public key and prove the bound session can no longer refresh after its current access token expires.

The service stores the assertion key ID with each delegation so the key-removal result can be attributed to the correct session generation.

## Evidence schema

Each CLI report contains:

- `version`: evidence schema version;
- `phase`: `authorize`, `resume`, or `revoke`;
- `provider`: `bluesky` or `cirrus`;
- `generatedAt`: report time;
- `oauth.requestedScope`;
- redacted session metadata before and after the phase;
- refresh and revocation observations; and
- the complete PDS probe report.

The PDS report contains one row for each probe:

| Probe              | Expected result            |
| ------------------ | -------------------------- |
| `release-create`   | Allowed                    |
| `release-readback` | Allowed                    |
| `release-update`   | Denied with a 4xx response |
| `release-delete`   | Denied with a 4xx response |
| `profile-create`   | Denied with a 4xx response |
| `unrelated-create` | Denied with a 4xx response |

Do not commit raw evidence until it has been inspected for unexpected provider data. A reviewed summary matrix belongs in the RFC or implementation plan; sensitive OAuth state never does.

## Result matrix

| Provider           | Public-client scope   | Public-client refresh | Public-client revocation | Confidential scope         | Confidential refresh | Revocation/key removal | Status            |
| ------------------ | --------------------- | --------------------- | ------------------------ | -------------------------- | -------------------- | ---------------------- | ----------------- |
| Bluesky-hosted PDS | Pending authorization | Pending               | Pending                  | Pending service deployment | Pending              | Pending                | Not supported yet |
| Cirrus             | Pending authorization | Pending               | Pending                  | Pending service deployment | Pending              | Pending                | Not supported yet |

## G0 completion criteria

G0 is complete only when:

- the RFC names the active exact scope and rejects broad fallback;
- the RFC and service specification agree on actors, authentication, Durable Object ownership, asynchronous intents, policy, approval, and provenance;
- the public-client preflight passes on Bluesky-hosted PDS and Cirrus;
- the confidential-client scope and refresh run passes on both;
- explicit revocation and client-key removal observations are recorded for both;
- any implementation difference is resolved in code, the support matrix, or the RFC before support is claimed; and
- the reviewed result matrix contains links or hashes for the retained redacted evidence.

The current preparation is complete when the harness builds and passes local tests, the operator procedure is executable up to browser authorization, and both real-account runs are ready for the account owner.
