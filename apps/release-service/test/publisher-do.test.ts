import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const DID = "did:plc:publisher";
const OTHER_DID = "did:plc:other";
const STATE_HASH = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function publisher() {
	return env.PUBLISHER_DO.getByName(DID);
}

afterEach(async () => {
	await reset();
});

describe("PublisherDurableObject", () => {
	it("routes and binds one object to one publisher DID", async () => {
		const stub = publisher();
		await stub.initializePublisher(DID);
		await runInDurableObject(stub, async (instance) => {
			expect(() => instance.initializePublisher(OTHER_DID)).toThrowError(
				expect.objectContaining({ code: "PUBLISHER_DID_MISMATCH" }),
			);
		});

		const unnamedStub = env.PUBLISHER_DO.get(env.PUBLISHER_DO.newUniqueId());
		await runInDurableObject(unnamedStub, async (instance) => {
			expect(() => instance.initializePublisher(DID)).toThrowError(
				expect.objectContaining({ code: "PUBLISHER_DID_MISMATCH" }),
			);
		});
	});

	it("stores encrypted OAuth state without plaintext and consumes it once", async () => {
		const stub = publisher();
		await expect(
			stub.putOAuthState({
				publisherDid: DID,
				stateHash: STATE_HASH,
				encryptedState: "encrypted-oauth-state",
				clientKeyId: "assertion-1",
				redirectTarget: "/publisher/delegation",
				expiresAt: Date.now() + 60_000,
			}),
		).resolves.toEqual({ ok: true });

		const storedRows = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ state_hash: string; encrypted_state: string }>(
					"SELECT state_hash, encrypted_state FROM oauth_states",
				)
				.toArray(),
		);
		expect(storedRows).toEqual([
			{ state_hash: STATE_HASH, encrypted_state: "encrypted-oauth-state" },
		]);
		expect(JSON.stringify(storedRows)).not.toContain("pkce-secret");

		await expect(stub.consumeOAuthState(DID, STATE_HASH)).resolves.toMatchObject({
			encryptedState: "encrypted-oauth-state",
			clientKeyId: "assertion-1",
		});
		await expect(stub.consumeOAuthState(DID, STATE_HASH)).resolves.toBeNull();

		const auditRows = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{
					event_type: string;
					actor_realm: string;
					actor_identity: string;
					public_payload: string;
				}>(
					`SELECT event_type, actor_realm, actor_identity, public_payload
					 FROM audit_events ORDER BY sequence`,
				)
				.toArray(),
		);
		expect(auditRows).toEqual([
			{
				event_type: "oauth-state-created",
				actor_realm: "publisher",
				actor_identity: DID,
				public_payload: "{}",
			},
			{
				event_type: "oauth-state-consumed",
				actor_realm: "publisher",
				actor_identity: DID,
				public_payload: "{}",
			},
		]);
		expect(JSON.stringify(auditRows)).not.toContain("encrypted-oauth-state");
	});

	it("rejects duplicate state and deletes expired state on consume", async () => {
		const stub = publisher();
		const stateHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const expiresAt = Date.now() + 60_000;
		const input = {
			publisherDid: DID,
			stateHash,
			encryptedState: "encrypted",
			clientKeyId: "assertion-1",
			redirectTarget: "/callback",
			expiresAt,
		};
		await expect(stub.putOAuthState(input)).resolves.toEqual({ ok: true });
		await expect(stub.putOAuthState(input)).resolves.toEqual({
			ok: false,
			code: "OAUTH_STATE_EXISTS",
		});
		await expect(stub.consumeOAuthState(DID, stateHash, expiresAt + 1)).resolves.toBeNull();
		const expiredAudit = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ event_type: string; actor_realm: string; reason_code: string | null }>(
					`SELECT event_type, actor_realm, reason_code FROM audit_events
					 WHERE event_type = 'oauth-state-expired'`,
				)
				.one(),
		);
		expect(expiredAudit).toEqual({
			event_type: "oauth-state-expired",
			actor_realm: "system",
			reason_code: "OAUTH_STATE_EXPIRED",
		});
	});

	it("applies compare-and-set delegation updates and revocation", async () => {
		const stub = publisher();
		const firstResult = await stub.putDelegation({
			publisherDid: DID,
			releaseNsid: "com.emdashcms.experimental.package.release",
			scope: "atproto repo:com.emdashcms.experimental.package.release?action=create",
			clientKeyId: "assertion-1",
			encryptedSession: "ciphertext-v1",
			refreshBefore: Date.now() + 60_000,
			expectedVersion: null,
		});
		expect(firstResult.ok).toBe(true);
		if (!firstResult.ok) return;
		const first = firstResult.delegation;
		expect(first).toMatchObject({ status: "active", stateVersion: 1 });

		await expect(
			stub.putDelegation({
				publisherDid: DID,
				releaseNsid: first.releaseNsid,
				scope: first.scope,
				clientKeyId: "assertion-2",
				encryptedSession: "ciphertext-v2",
				refreshBefore: null,
				expectedVersion: null,
			}),
		).resolves.toEqual({ ok: false, code: "DELEGATION_CAS_REQUIRED" });

		const secondResult = await stub.putDelegation({
			publisherDid: DID,
			releaseNsid: first.releaseNsid,
			scope: first.scope,
			clientKeyId: "assertion-2",
			encryptedSession: "ciphertext-v2",
			refreshBefore: null,
			expectedVersion: 1,
		});
		expect(secondResult.ok).toBe(true);
		if (!secondResult.ok) return;
		const second = secondResult.delegation;
		expect(second).toMatchObject({ status: "active", stateVersion: 2 });

		await expect(stub.revokeDelegation(DID, 1)).resolves.toEqual({
			ok: false,
			code: "DELEGATION_CAS_REQUIRED",
		});
		const revoked = await stub.revokeDelegation(DID, 2);
		expect(revoked.ok).toBe(true);
		if (revoked.ok) {
			expect(revoked.delegation).toMatchObject({ status: "revoked", stateVersion: 3 });
		}
	});

	it("persists canonical state across object restarts", async () => {
		const stub = publisher();
		await expect(
			stub.putDelegation({
				publisherDid: DID,
				releaseNsid: "com.emdashcms.experimental.package.release",
				scope: "atproto repo:com.emdashcms.experimental.package.release?action=create",
				clientKeyId: "assertion-1",
				encryptedSession: "persisted-ciphertext",
				refreshBefore: null,
				expectedVersion: null,
			}),
		).resolves.toMatchObject({ ok: true });

		await abortAllDurableObjects();
		await expect(env.PUBLISHER_DO.getByName(DID).getDelegation(DID)).resolves.toMatchObject({
			encryptedSession: "persisted-ciphertext",
			stateVersion: 1,
		});
	});
});
