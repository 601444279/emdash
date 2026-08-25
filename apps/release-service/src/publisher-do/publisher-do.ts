import { DurableObject } from "cloudflare:workers";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_CIPHERTEXT_CHARS = 1_500_000;

export type PublisherStateErrorCode =
	| "PUBLISHER_DID_INVALID"
	| "PUBLISHER_DID_MISMATCH"
	| "OAUTH_STATE_INVALID"
	| "OAUTH_STATE_EXISTS"
	| "DELEGATION_INVALID"
	| "DELEGATION_CAS_REQUIRED";

export class PublisherStateError extends Error {
	readonly code: PublisherStateErrorCode;

	constructor(code: PublisherStateErrorCode) {
		super(code);
		this.name = "PublisherStateError";
		this.code = code;
	}
}

export interface PutOAuthStateInput {
	publisherDid: string;
	stateHash: string;
	encryptedState: string;
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
}

export interface StoredOAuthState {
	encryptedState: string;
	clientKeyId: string;
	redirectTarget: string;
	expiresAt: number;
}

export type PutOAuthStateResult = { ok: true } | { ok: false; code: "OAUTH_STATE_EXISTS" };

export interface PutDelegationInput {
	publisherDid: string;
	releaseNsid: string;
	scope: string;
	clientKeyId: string;
	encryptedSession: string;
	refreshBefore: number | null;
	expectedVersion: number | null;
}

export interface StoredDelegation {
	releaseNsid: string;
	scope: string;
	clientKeyId: string;
	encryptedSession: string;
	refreshBefore: number | null;
	status: "active" | "revoked" | "reauthorization_required";
	stateVersion: number;
}

export type PutDelegationResult =
	| { ok: true; delegation: StoredDelegation }
	| { ok: false; code: "DELEGATION_CAS_REQUIRED" };

export type RevokeDelegationResult =
	| { ok: true; delegation: StoredDelegation }
	| { ok: false; code: "DELEGATION_CAS_REQUIRED" };

interface PublisherRow {
	[key: string]: string | number | ArrayBuffer | null;
	did: string;
}

interface OAuthStateRow {
	[key: string]: string | number | ArrayBuffer | null;
	encrypted_state: string;
	client_key_id: string;
	redirect_target: string;
	expires_at: number;
}

interface DelegationRow {
	[key: string]: string | number | ArrayBuffer | null;
	release_nsid: string;
	scope: string;
	client_key_id: string;
	encrypted_session: string;
	refresh_before: number | null;
	status: StoredDelegation["status"];
	state_version: number;
}

function validBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export class PublisherDurableObject extends DurableObject<Env> {
	readonly #objectName: string | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#objectName = ctx.id.name;
		void ctx.blockConcurrencyWhile(async () => {
			this.#initializeSchema();
		});
	}

	#initializeSchema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS publisher (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				did TEXT NOT NULL UNIQUE,
				status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
				session_epoch INTEGER NOT NULL DEFAULT 1 CHECK (session_epoch >= 1),
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS oauth_states (
				state_hash TEXT PRIMARY KEY,
				encrypted_state TEXT NOT NULL,
				encryption_key_version INTEGER,
				client_key_id TEXT NOT NULL,
				redirect_target TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);
			CREATE TABLE IF NOT EXISTS delegation (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				release_nsid TEXT NOT NULL,
				scope TEXT NOT NULL,
				client_key_id TEXT NOT NULL,
				encrypted_session TEXT NOT NULL,
				encryption_key_version INTEGER,
				issuer TEXT,
				pds_url TEXT,
				expires_at INTEGER,
				refresh_before INTEGER,
				status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'reauthorization_required')),
				state_version INTEGER NOT NULL CHECK (state_version >= 1),
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS delegation_operations (
				kind TEXT PRIMARY KEY CHECK (kind = 'refresh'),
				generation INTEGER NOT NULL CHECK (generation >= 0),
				token_hash TEXT,
				delegation_version INTEGER,
				expires_at INTEGER,
				updated_at INTEGER NOT NULL,
				CHECK (
					(token_hash IS NULL AND delegation_version IS NULL AND expires_at IS NULL)
					OR (token_hash IS NOT NULL AND delegation_version IS NOT NULL AND expires_at IS NOT NULL)
				)
			);
			INSERT OR IGNORE INTO delegation_operations (
				kind, generation, token_hash, delegation_version, expires_at, updated_at
			) VALUES ('refresh', 0, NULL, NULL, NULL, 0);
			CREATE TABLE IF NOT EXISTS publisher_sessions (
				token_hash TEXT PRIMARY KEY,
				csrf_hash TEXT NOT NULL,
				session_epoch INTEGER NOT NULL CHECK (session_epoch >= 1),
				expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_publisher_sessions_expiry
				ON publisher_sessions(expires_at);
			CREATE TABLE IF NOT EXISTS audit_events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				event_type TEXT NOT NULL,
				actor_realm TEXT NOT NULL CHECK (actor_realm IN ('oidc', 'publisher', 'approver', 'access', 'system')),
				actor_identity TEXT NOT NULL,
				subject TEXT NOT NULL,
				reason_code TEXT,
				public_payload TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
	}

	#assertPublisherDid(publisherDid: string): void {
		if (!DID_PATTERN.test(publisherDid)) {
			throw new PublisherStateError("PUBLISHER_DID_INVALID");
		}
		if (this.#objectName === undefined || this.#objectName !== publisherDid) {
			throw new PublisherStateError("PUBLISHER_DID_MISMATCH");
		}
		const existing = this.ctx.storage.sql
			.exec<PublisherRow>("SELECT did FROM publisher WHERE id = 1")
			.toArray()[0];
		if (existing && existing.did !== publisherDid) {
			throw new PublisherStateError("PUBLISHER_DID_MISMATCH");
		}
		if (!existing) {
			this.ctx.storage.sql.exec(
				"INSERT INTO publisher (id, did, created_at) VALUES (1, ?, ?)",
				publisherDid,
				Date.now(),
			);
		}
	}

	#appendAudit(
		eventType: string,
		actorRealm: "publisher" | "system",
		actorIdentity: string,
		subject: string,
		createdAt: number,
		reasonCode: string | null = null,
	): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO audit_events (
				event_type, actor_realm, actor_identity, subject, reason_code, public_payload, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			eventType,
			actorRealm,
			actorIdentity,
			subject,
			reasonCode,
			"{}",
			createdAt,
		);
	}

	initializePublisher(publisherDid: string): void {
		this.#assertPublisherDid(publisherDid);
	}

	putOAuthState(input: PutOAuthStateInput): PutOAuthStateResult {
		this.#assertPublisherDid(input.publisherDid);
		if (
			!HASH_PATTERN.test(input.stateHash) ||
			!validBoundedString(input.encryptedState, MAX_CIPHERTEXT_CHARS) ||
			!validBoundedString(input.clientKeyId, 128) ||
			!validBoundedString(input.redirectTarget, 2048) ||
			!Number.isSafeInteger(input.expiresAt) ||
			input.expiresAt <= Date.now()
		) {
			throw new PublisherStateError("OAUTH_STATE_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const existing = this.ctx.storage.sql
				.exec<{ state_hash: string }>(
					"SELECT state_hash FROM oauth_states WHERE state_hash = ?",
					input.stateHash,
				)
				.toArray()[0];
			if (existing) return { ok: false, code: "OAUTH_STATE_EXISTS" } as const;
			this.ctx.storage.sql.exec(
				`INSERT INTO oauth_states (
						state_hash, encrypted_state, client_key_id, redirect_target, expires_at, created_at
					) VALUES (?, ?, ?, ?, ?, ?)`,
				input.stateHash,
				input.encryptedState,
				input.clientKeyId,
				input.redirectTarget,
				input.expiresAt,
				Date.now(),
			);
			this.#appendAudit(
				"oauth-state-created",
				"publisher",
				input.publisherDid,
				input.stateHash,
				Date.now(),
			);
			return { ok: true } as const;
		});
	}

	consumeOAuthState(
		publisherDid: string,
		stateHash: string,
		now = Date.now(),
	): StoredOAuthState | null {
		this.#assertPublisherDid(publisherDid);
		if (!HASH_PATTERN.test(stateHash) || !Number.isSafeInteger(now)) {
			throw new PublisherStateError("OAUTH_STATE_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const row = this.ctx.storage.sql
				.exec<OAuthStateRow>(
					`SELECT encrypted_state, client_key_id, redirect_target, expires_at
					 FROM oauth_states WHERE state_hash = ?`,
					stateHash,
				)
				.toArray()[0];
			if (!row) return null;
			this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE state_hash = ?", stateHash);
			if (row.expires_at <= now) {
				this.#appendAudit(
					"oauth-state-expired",
					"system",
					"release-service",
					stateHash,
					now,
					"OAUTH_STATE_EXPIRED",
				);
				return null;
			}
			this.#appendAudit("oauth-state-consumed", "publisher", publisherDid, stateHash, now);
			return {
				encryptedState: row.encrypted_state,
				clientKeyId: row.client_key_id,
				redirectTarget: row.redirect_target,
				expiresAt: row.expires_at,
			};
		});
	}

	putDelegation(input: PutDelegationInput): PutDelegationResult {
		this.#assertPublisherDid(input.publisherDid);
		if (
			!validBoundedString(input.releaseNsid, 512) ||
			!validBoundedString(input.scope, 2048) ||
			!validBoundedString(input.clientKeyId, 128) ||
			!validBoundedString(input.encryptedSession, MAX_CIPHERTEXT_CHARS) ||
			(input.refreshBefore !== null && !Number.isSafeInteger(input.refreshBefore)) ||
			(input.expectedVersion !== null &&
				(!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1))
		) {
			throw new PublisherStateError("DELEGATION_INVALID");
		}
		return this.ctx.storage.transactionSync(() => {
			const current = this.#readDelegation();
			if (
				(current === null && input.expectedVersion !== null) ||
				(current !== null && input.expectedVersion !== current.stateVersion)
			) {
				return { ok: false, code: "DELEGATION_CAS_REQUIRED" } as const;
			}
			const stateVersion = (current?.stateVersion ?? 0) + 1;
			this.ctx.storage.sql.exec(
				`INSERT INTO delegation (
					id, release_nsid, scope, client_key_id, encrypted_session,
					refresh_before, status, state_version, updated_at
				) VALUES (1, ?, ?, ?, ?, ?, 'active', ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					release_nsid = excluded.release_nsid,
					scope = excluded.scope,
					client_key_id = excluded.client_key_id,
					encrypted_session = excluded.encrypted_session,
					refresh_before = excluded.refresh_before,
					status = 'active',
					state_version = excluded.state_version,
					updated_at = excluded.updated_at`,
				input.releaseNsid,
				input.scope,
				input.clientKeyId,
				input.encryptedSession,
				input.refreshBefore,
				stateVersion,
				Date.now(),
			);
			this.#appendAudit(
				"delegation-stored",
				"publisher",
				input.publisherDid,
				input.releaseNsid,
				Date.now(),
			);
			return { ok: true, delegation: this.#readDelegation()! } as const;
		});
	}

	getDelegation(publisherDid: string): StoredDelegation | null {
		this.#assertPublisherDid(publisherDid);
		return this.#readDelegation();
	}

	revokeDelegation(publisherDid: string, expectedVersion: number): RevokeDelegationResult {
		this.#assertPublisherDid(publisherDid);
		return this.ctx.storage.transactionSync(() => {
			const current = this.#readDelegation();
			if (!current || current.stateVersion !== expectedVersion) {
				return { ok: false, code: "DELEGATION_CAS_REQUIRED" } as const;
			}
			const stateVersion = current.stateVersion + 1;
			this.ctx.storage.sql.exec(
				"UPDATE delegation SET status = 'revoked', state_version = ?, updated_at = ? WHERE id = 1",
				stateVersion,
				Date.now(),
			);
			this.#appendAudit(
				"delegation-revoked",
				"publisher",
				publisherDid,
				current.releaseNsid,
				Date.now(),
			);
			return { ok: true, delegation: this.#readDelegation()! } as const;
		});
	}

	#readDelegation(): StoredDelegation | null {
		const row = this.ctx.storage.sql
			.exec<DelegationRow>(
				`SELECT release_nsid, scope, client_key_id, encrypted_session,
				        refresh_before, status, state_version
				 FROM delegation WHERE id = 1`,
			)
			.toArray()[0];
		return row
			? {
					releaseNsid: row.release_nsid,
					scope: row.scope,
					clientKeyId: row.client_key_id,
					encryptedSession: row.encrypted_session,
					refreshBefore: row.refresh_before,
					status: row.status,
					stateVersion: row.state_version,
				}
			: null;
	}
}
