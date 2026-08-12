import { sql, type Kysely, type RawBuilder, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { isPostgres } from "../../database/dialect-helpers.js";
import type { Database, MediaUsageReconciliationTable } from "../../database/types.js";

const ACTIVATION_KEY = "incremental_capture";
const CONTENT_ADAPTER_ID = "content-media";
const COLLECTION_SCOPE = "collection";
const MAX_CANDIDATES = 100;
const MAX_PORTABLE_DURATION_SECONDS = 365 * 24 * 60 * 60;
const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export type MediaUsageReconciliationState = "pending" | "retry" | "leased" | "failed";
export type MediaUsageReconciliationPhase = "scan" | "sources";

export interface MediaUsageReconciliationRecord {
	collectionId: string;
	collectionSlug: string;
	runToken: string;
	targetEpoch: number | string | null;
	fieldFingerprint: string | null;
	state: MediaUsageReconciliationState;
	phase: MediaUsageReconciliationPhase;
	scanCursor: string | null;
	scanUpperId: string | null;
	sourceCursor: string | null;
	sourceUpperKey: string | null;
	attemptCount: number;
	nextAttemptAt: string;
	leaseToken: string | null;
	leaseExpiresAt: string | null;
	lastErrorCode: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MediaUsageReconciliationClaim extends MediaUsageReconciliationRecord {
	leaseToken: string;
}

export class MediaUsageReconciliationRepository {
	constructor(private db: Kysely<Database>) {}

	async seedNextCandidate(): Promise<boolean> {
		const runToken = ulid();
		const now = timestampOffset(this.db, 0);
		const result = await sql<{ collection_id: string }>`
			INSERT INTO _emdash_media_usage_reconciliations (
				collection_id,
				collection_slug,
				run_token,
				next_attempt_at,
				updated_at
			)
			SELECT status.collection_id, status.scope_key, ${runToken}, ${now}, ${now}
			FROM _emdash_media_usage_index_status AS status
			INNER JOIN _emdash_collections AS collection
				ON collection.id = status.collection_id
				AND collection.slug = status.scope_key
			WHERE status.adapter_id = ${CONTENT_ADAPTER_ID}
				AND status.scope_type = ${COLLECTION_SCOPE}
				AND status.capture_state = 'active'
				AND status.reconciliation_required = 1
				AND status.collection_id IS NOT NULL
				AND EXISTS (
					SELECT 1 FROM _emdash_media_usage_activation AS activation
					WHERE activation.task_key = ${ACTIVATION_KEY}
						AND activation.state = 'active'
				)
				AND NOT EXISTS (
					SELECT 1 FROM _emdash_media_usage_reconciliations AS existing
					WHERE existing.collection_id = status.collection_id
				)
				AND NOT EXISTS (
					SELECT 1 FROM _emdash_media_usage_collection_deletions AS deletion
					WHERE deletion.collection_id = status.collection_id
				)
			ORDER BY status.collection_id
			LIMIT 1
			ON CONFLICT (collection_id) DO NOTHING
			RETURNING collection_id
		`.execute(this.db);
		return result.rows.length === 1;
	}

	async findDue(limit: number): Promise<MediaUsageReconciliationRecord[]> {
		assertLimit(limit);
		const nextAttemptIsDue = timestampIsDue(this.db, "next_attempt_at");
		const leaseIsDue = timestampIsDue(this.db, "lease_expires_at");
		const result = await sql<Selectable<MediaUsageReconciliationTable>>`
			WITH pending_candidates AS (
				SELECT * FROM _emdash_media_usage_reconciliations
				WHERE state = 'pending' AND ${nextAttemptIsDue}
				ORDER BY next_attempt_at, updated_at, collection_id
				LIMIT ${limit}
			), retry_candidates AS (
				SELECT * FROM _emdash_media_usage_reconciliations
				WHERE state = 'retry' AND ${nextAttemptIsDue}
				ORDER BY next_attempt_at, updated_at, collection_id
				LIMIT ${limit}
			), leased_candidates AS (
				SELECT * FROM _emdash_media_usage_reconciliations
				WHERE state = 'leased' AND ${leaseIsDue}
				ORDER BY lease_expires_at, updated_at, collection_id
				LIMIT ${limit}
			), candidates AS (
				SELECT * FROM pending_candidates
				UNION ALL SELECT * FROM retry_candidates
				UNION ALL SELECT * FROM leased_candidates
			)
			SELECT * FROM candidates
			ORDER BY CASE WHEN state = 'leased' THEN lease_expires_at ELSE next_attempt_at END,
				updated_at,
				collection_id
			LIMIT ${limit}
		`.execute(this.db);
		return result.rows.map(rowToRecord);
	}

	async findFailed(limit: number): Promise<MediaUsageReconciliationRecord[]> {
		assertLimit(limit);
		const rows = await this.db
			.selectFrom("_emdash_media_usage_reconciliations as reconciliation")
			.innerJoin("_emdash_media_usage_index_status as status", (join) =>
				join
					.onRef("status.collection_id", "=", "reconciliation.collection_id")
					.onRef("status.scope_key", "=", "reconciliation.collection_slug"),
			)
			.selectAll("reconciliation")
			.where("reconciliation.state", "=", "failed")
			.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
			.where("status.scope_type", "=", COLLECTION_SCOPE)
			.orderBy("reconciliation.updated_at")
			.orderBy("reconciliation.collection_id")
			.limit(limit)
			.execute();
		return rows.map(rowToRecord);
	}

	async claim(input: {
		collectionId: string;
		runToken: string;
		leaseDurationSeconds: number;
	}): Promise<MediaUsageReconciliationClaim | null> {
		assertIdentity(input);
		assertDuration(input.leaseDurationSeconds, "lease duration");
		const leaseToken = ulid();
		const row = await this.db
			.updateTable("_emdash_media_usage_reconciliations as reconciliation")
			.set({
				state: "leased",
				lease_token: leaseToken,
				lease_expires_at: timestampOffset(this.db, input.leaseDurationSeconds),
				updated_at: timestampOffset(this.db, 0),
			})
			.where("reconciliation.collection_id", "=", input.collectionId)
			.where("reconciliation.run_token", "=", input.runToken)
			.where((eb) =>
				eb.or([
					eb.and([
						eb("reconciliation.state", "in", ["pending", "retry"]),
						timestampIsDue(this.db, "reconciliation.next_attempt_at"),
					]),
					eb.and([
						eb("reconciliation.state", "=", "leased"),
						timestampIsDue(this.db, "reconciliation.lease_expires_at"),
					]),
				]),
			)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_activation as activation")
						.select("activation.task_key")
						.where("activation.task_key", "=", ACTIVATION_KEY)
						.where("activation.state", "=", "active"),
				),
			)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_index_status as status")
						.innerJoin("_emdash_collections as collection", (join) =>
							join
								.onRef("collection.id", "=", "status.collection_id")
								.onRef("collection.slug", "=", "status.scope_key"),
						)
						.select("status.collection_id")
						.whereRef("status.collection_id", "=", "reconciliation.collection_id")
						.whereRef("status.scope_key", "=", "reconciliation.collection_slug")
						.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
						.where("status.scope_type", "=", COLLECTION_SCOPE)
						.where("status.capture_state", "=", "active")
						.where("status.reconciliation_required", "=", 1),
				),
			)
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("_emdash_media_usage_collection_deletions as deletion")
							.select("deletion.collection_id")
							.whereRef("deletion.collection_id", "=", "reconciliation.collection_id"),
					),
				),
			)
			.returningAll()
			.executeTakeFirst();
		return row
			? ({ ...rowToRecord(row), leaseToken } satisfies MediaUsageReconciliationClaim)
			: null;
	}

	async release(input: {
		collectionId: string;
		runToken: string;
		leaseToken: string;
		delaySeconds: number;
	}): Promise<boolean> {
		assertLeaseIdentity(input);
		assertDuration(input.delaySeconds, "release delay", true);
		const result = await this.db
			.updateTable("_emdash_media_usage_reconciliations")
			.set({
				state: "pending",
				next_attempt_at: timestampOffset(this.db, input.delaySeconds),
				lease_token: null,
				lease_expires_at: null,
				updated_at: timestampOffset(this.db, 0),
			})
			.where("collection_id", "=", input.collectionId)
			.where("run_token", "=", input.runToken)
			.where("state", "=", "leased")
			.where("lease_token", "=", input.leaseToken)
			.where(liveLease(this.db))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async recordFailure(input: {
		collectionId: string;
		runToken: string;
		leaseToken: string;
		errorCode: string;
		retryDelaySeconds: number;
		terminal: boolean;
	}): Promise<boolean> {
		assertLeaseIdentity(input);
		if (!STABLE_ERROR_CODE_PATTERN.test(input.errorCode)) {
			throw new Error("Reconciliation failure requires a stable error code");
		}
		assertDuration(input.retryDelaySeconds, "retry delay", true);
		const result = await this.db
			.updateTable("_emdash_media_usage_reconciliations")
			.set({
				state: input.terminal
					? "failed"
					: sql<string>`CASE WHEN attempt_count >= 4 THEN 'failed' ELSE 'retry' END`,
				attempt_count: sql<number>`attempt_count + 1`,
				next_attempt_at: timestampOffset(this.db, input.retryDelaySeconds),
				lease_token: null,
				lease_expires_at: null,
				last_error_code: input.errorCode,
				updated_at: timestampOffset(this.db, 0),
			})
			.where("collection_id", "=", input.collectionId)
			.where("run_token", "=", input.runToken)
			.where("state", "=", "leased")
			.where("lease_token", "=", input.leaseToken)
			.where(liveLease(this.db))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async deleteObsoleteFailed(
		observed: Selectable<MediaUsageReconciliationTable>,
	): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_emdash_media_usage_reconciliations as reconciliation")
			.where("reconciliation.collection_id", "=", observed.collection_id)
			.where("reconciliation.run_token", "=", observed.run_token)
			.where("reconciliation.state", "=", "failed")
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_index_status as status")
						.select("status.collection_id")
						.whereRef("status.collection_id", "=", "reconciliation.collection_id")
						.whereRef("status.scope_key", "=", "reconciliation.collection_slug")
						.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
						.where("status.scope_type", "=", COLLECTION_SCOPE)
						.where("status.reconciliation_required", "=", 0),
				),
			)
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0) === 1;
	}

	async resetFailedForNewEpoch(
		observed: Selectable<MediaUsageReconciliationTable>,
	): Promise<boolean> {
		if (observed.target_epoch === null) return false;
		const now = timestampOffset(this.db, 0);
		const result = await this.db
			.updateTable("_emdash_media_usage_reconciliations as reconciliation")
			.set({
				state: "pending",
				phase: "scan",
				target_epoch: null,
				field_fingerprint: null,
				scan_cursor: null,
				scan_upper_id: null,
				source_cursor: null,
				source_upper_key: null,
				attempt_count: 0,
				next_attempt_at: now,
				lease_token: null,
				lease_expires_at: null,
				last_error_code: null,
				updated_at: now,
			})
			.where("reconciliation.collection_id", "=", observed.collection_id)
			.where("reconciliation.run_token", "=", observed.run_token)
			.where("reconciliation.state", "=", "failed")
			.where("reconciliation.target_epoch", "=", observed.target_epoch)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_index_status as status")
						.select("status.collection_id")
						.whereRef("status.collection_id", "=", "reconciliation.collection_id")
						.whereRef("status.scope_key", "=", "reconciliation.collection_slug")
						.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
						.where("status.scope_type", "=", COLLECTION_SCOPE)
						.where("status.capture_state", "=", "active")
						.where("status.reconciliation_required", "=", 1)
						.where("status.cursor", "is", null)
						.where("status.change_epoch", ">", observed.target_epoch!),
				),
			)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}
}

function rowToRecord(
	row: Selectable<MediaUsageReconciliationTable>,
): MediaUsageReconciliationRecord {
	if (!isState(row.state) || !isPhase(row.phase) || !Number.isSafeInteger(row.attempt_count)) {
		throw new Error("Invalid media usage reconciliation lifecycle");
	}
	return {
		collectionId: row.collection_id,
		collectionSlug: row.collection_slug,
		runToken: row.run_token,
		targetEpoch: row.target_epoch,
		fieldFingerprint: row.field_fingerprint,
		state: row.state,
		phase: row.phase,
		scanCursor: row.scan_cursor,
		scanUpperId: row.scan_upper_id,
		sourceCursor: row.source_cursor,
		sourceUpperKey: row.source_upper_key,
		attemptCount: row.attempt_count,
		nextAttemptAt: row.next_attempt_at,
		leaseToken: row.lease_token,
		leaseExpiresAt: row.lease_expires_at,
		lastErrorCode: row.last_error_code,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function isState(state: string): state is MediaUsageReconciliationState {
	return state === "pending" || state === "retry" || state === "leased" || state === "failed";
}

function isPhase(phase: string): phase is MediaUsageReconciliationPhase {
	return phase === "scan" || phase === "sources";
}

function assertLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANDIDATES) {
		throw new Error("Reconciliation candidate limit must be from 1 to 100");
	}
}

function assertIdentity(input: { collectionId: string; runToken: string }): void {
	if (!input.collectionId || !input.runToken) {
		throw new Error("Reconciliation requires an exact collection and run token");
	}
}

function assertLeaseIdentity(input: {
	collectionId: string;
	runToken: string;
	leaseToken: string;
}): void {
	assertIdentity(input);
	if (!input.leaseToken) throw new Error("Reconciliation requires a lease token");
}

function assertDuration(value: number, label: string, allowZero = false): void {
	if (
		!Number.isSafeInteger(value) ||
		value < (allowZero ? 0 : 1) ||
		value > MAX_PORTABLE_DURATION_SECONDS
	) {
		throw new Error(`Reconciliation ${label} is outside the portable range`);
	}
}

function liveLease(db: Kysely<Database>): RawBuilder<boolean> {
	return isPostgres(db)
		? sql<boolean>`lease_expires_at > to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
		: sql<boolean>`lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

function timestampIsDue(db: Kysely<Database>, column: string): RawBuilder<boolean> {
	const value = sql.ref(column);
	return isPostgres(db)
		? sql<boolean>`${value} <= to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
		: sql<boolean>`${value} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

function timestampOffset(db: Kysely<Database>, offsetSeconds: number): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql<string>`to_char(
			(clock_timestamp() AT TIME ZONE 'UTC') + (${offsetSeconds} * INTERVAL '1 second'),
			'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		)`;
	}
	return sql<string>`strftime(
		'%Y-%m-%dT%H:%M:%fZ',
		'now',
		${`${offsetSeconds >= 0 ? "+" : ""}${offsetSeconds} seconds`}
	)`;
}
