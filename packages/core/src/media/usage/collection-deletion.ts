import { sql, type Kysely, type RawBuilder, type Selectable, type Transaction } from "kysely";
import { ulid } from "ulidx";

import { isPostgres } from "../../database/dialect-helpers.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database, MediaUsageCollectionDeletionTable } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import type {
	CollectionDeletionGuardInput,
	CollectionDeletionGuardResult,
} from "../../db/adapters.js";
import { FTSManager } from "../../search/fts-manager.js";
import { verifyMediaUsageCaptureTriggers } from "./capture-triggers.js";

const ACTIVATION_KEY = "incremental_capture";
const VIRTUAL_DIALECT_ID = "virtual:emdash/dialect";

export type MediaUsageCollectionDeletionState = "pending" | "retry" | "leased" | "failed";
export type MediaUsageCollectionDeletionPhase =
	| "fence"
	| "registry"
	| "table"
	| "work"
	| "sources"
	| "status"
	| "finalize";

export interface MediaUsageCollectionDeletionRecord {
	collectionId: string;
	collectionSlug: string;
	forceDelete: boolean;
	state: MediaUsageCollectionDeletionState;
	phase: MediaUsageCollectionDeletionPhase;
	workCursor: string | null;
	sourceKey: string | null;
	occurrenceCursor: string | null;
	attemptCount: number;
	nextAttemptAt: string;
	leaseToken: string | null;
	leaseExpiresAt: string | null;
	lastErrorCode: string | null;
	createdAt: string;
	updatedAt: string;
}

export class MediaUsageCollectionDeletionRepository {
	constructor(private db: Kysely<Database>) {}

	async createTombstone(input: {
		collectionId: string;
		collectionSlug: string;
		forceDelete: boolean;
	}): Promise<MediaUsageCollectionDeletionRecord> {
		assertIdentity(input);
		const now = timestampOffset(this.db, 0);
		await this.db
			.insertInto("_emdash_media_usage_collection_deletions")
			.values({
				collection_id: input.collectionId,
				collection_slug: input.collectionSlug,
				force_delete: input.forceDelete ? 1 : 0,
				state: "pending",
				phase: "fence",
				next_attempt_at: now,
				updated_at: now,
			})
			.onConflict((conflict) => conflict.column("collection_id").doNothing())
			.execute();

		const row = await this.db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.selectAll()
			.where("collection_id", "=", input.collectionId)
			.executeTakeFirstOrThrow();
		if (
			row.collection_slug !== input.collectionSlug ||
			Boolean(row.force_delete) !== input.forceDelete
		) {
			throw new Error("Collection deletion tombstone identity conflicts with existing work");
		}
		return rowToRecord(row);
	}

	async claim(input: {
		collectionId: string;
		phase: MediaUsageCollectionDeletionPhase;
		leaseDurationSeconds: number;
	}): Promise<(MediaUsageCollectionDeletionRecord & { leaseToken: string }) | null> {
		if (!input.collectionId || !isPhase(input.phase)) {
			throw new Error("Collection deletion claim requires an exact identity and phase");
		}
		if (!Number.isSafeInteger(input.leaseDurationSeconds) || input.leaseDurationSeconds < 1) {
			throw new Error("Collection deletion lease duration must be a positive whole number");
		}
		const leaseToken = ulid();
		const row = await this.db
			.updateTable("_emdash_media_usage_collection_deletions")
			.set({
				state: "leased",
				lease_token: leaseToken,
				lease_expires_at: timestampOffset(this.db, input.leaseDurationSeconds),
				updated_at: timestampOffset(this.db, 0),
			})
			.where("collection_id", "=", input.collectionId)
			.where("phase", "=", input.phase)
			.where((eb) =>
				eb.or([
					eb.and([
						eb("state", "in", ["pending", "retry"]),
						timestampIsDue(this.db, "next_attempt_at"),
					]),
					eb.and([eb("state", "=", "leased"), timestampIsDue(this.db, "lease_expires_at")]),
				]),
			)
			.returningAll()
			.executeTakeFirst();
		if (!row) return null;
		return { ...rowToRecord(row), leaseToken };
	}

	async findBySlug(collectionSlug: string): Promise<MediaUsageCollectionDeletionRecord | null> {
		validateIdentifier(collectionSlug, "collection slug");
		const row = await this.db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.selectAll()
			.where("collection_slug", "=", collectionSlug)
			.executeTakeFirst();
		return row ? rowToRecord(row) : null;
	}

	async checkpoint(input: {
		collectionId: string;
		leaseToken: string;
		fromPhase: MediaUsageCollectionDeletionPhase;
		toPhase: MediaUsageCollectionDeletionPhase;
	}): Promise<boolean> {
		const result = await this.db
			.updateTable("_emdash_media_usage_collection_deletions")
			.set({ phase: input.toPhase, updated_at: timestampOffset(this.db, 0) })
			.where("collection_id", "=", input.collectionId)
			.where("state", "=", "leased")
			.where("phase", "=", input.fromPhase)
			.where("lease_token", "=", input.leaseToken)
			.where(liveLease(this.db))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async release(input: { collectionId: string; leaseToken: string }): Promise<boolean> {
		const now = timestampOffset(this.db, 0);
		const result = await this.db
			.updateTable("_emdash_media_usage_collection_deletions")
			.set({
				state: "pending",
				next_attempt_at: now,
				lease_token: null,
				lease_expires_at: null,
				updated_at: now,
			})
			.where("collection_id", "=", input.collectionId)
			.where("state", "=", "leased")
			.where("lease_token", "=", input.leaseToken)
			.where(liveLease(this.db))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async cancelFence(input: { collectionId: string; leaseToken: string }): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_emdash_media_usage_collection_deletions")
			.where("collection_id", "=", input.collectionId)
			.where("state", "=", "leased")
			.where("phase", "=", "fence")
			.where("lease_token", "=", input.leaseToken)
			.where(liveLease(this.db))
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0) === 1;
	}

	async deleteRegistryAndCheckpoint(input: {
		collectionId: string;
		collectionSlug: string;
		leaseToken: string;
	}): Promise<boolean> {
		return withTransaction(this.db, async (trx) => {
			await trx
				.deleteFrom("_emdash_collections")
				.where("id", "=", input.collectionId)
				.where("slug", "=", input.collectionSlug)
				.where((eb) =>
					eb.exists(
						eb
							.selectFrom("_emdash_media_usage_collection_deletions as deletion")
							.select("deletion.collection_id")
							.where("deletion.collection_id", "=", input.collectionId)
							.where("deletion.collection_slug", "=", input.collectionSlug)
							.where("deletion.state", "=", "leased")
							.where("deletion.phase", "=", "registry")
							.where("deletion.lease_token", "=", input.leaseToken)
							.where(liveLease(this.db, "deletion.lease_expires_at")),
					),
				)
				.execute();

			const checkpoint = await trx
				.updateTable("_emdash_media_usage_collection_deletions")
				.set({ phase: "table", updated_at: timestampOffset(this.db, 0) })
				.where("collection_id", "=", input.collectionId)
				.where("collection_slug", "=", input.collectionSlug)
				.where("state", "=", "leased")
				.where("phase", "=", "registry")
				.where("lease_token", "=", input.leaseToken)
				.where(liveLease(this.db))
				.executeTakeFirst();
			return Number(checkpoint.numUpdatedRows ?? 0) === 1;
		});
	}
}

export type ActivatedCollectionDeletionOutcome =
	| "inactive"
	| "not_found"
	| "in_progress"
	| "deleted"
	| "has_content";

export async function deleteActivatedMediaUsageCollection(
	db: Kysely<Database>,
	input: {
		collectionSlug: string;
		collectionId?: string;
		forceDelete: boolean;
	},
): Promise<ActivatedCollectionDeletionOutcome> {
	validateIdentifier(input.collectionSlug, "collection slug");
	const repository = new MediaUsageCollectionDeletionRepository(db);
	let deletion = await repository.findBySlug(input.collectionSlug);
	if (deletion && input.collectionId && deletion.collectionId !== input.collectionId) {
		throw new Error("Collection deletion tombstone identity conflict");
	}
	if (!deletion) {
		const activation = await db
			.selectFrom("_emdash_media_usage_activation")
			.select("state")
			.where("task_key", "=", ACTIVATION_KEY)
			.executeTakeFirst();
		if (!activation || activation.state === "expanded") return "inactive";
		if (activation.state !== "active") {
			throw new Error("Media usage activation must be active before collection deletion");
		}
		if (!input.collectionId) return "not_found";
		await assertActivatedCollectionDeletionReady(db, {
			collectionId: input.collectionId,
			collectionSlug: input.collectionSlug,
		});
		deletion = await repository.createTombstone({
			collectionId: input.collectionId,
			collectionSlug: input.collectionSlug,
			forceDelete: input.forceDelete,
		});
	}

	if (deletion.phase !== "fence" && deletion.phase !== "registry" && deletion.phase !== "table") {
		return "deleted";
	}
	const claim = await repository.claim({
		collectionId: deletion.collectionId,
		phase: deletion.phase,
		leaseDurationSeconds: 5 * 60,
	});
	if (!claim) return "in_progress";
	let phase = claim.phase;
	const lease = { collectionId: claim.collectionId, leaseToken: claim.leaseToken };

	if (phase === "fence") {
		const captureState = await findCollectionCaptureState(db, claim);
		if (captureState !== "active" && captureState !== "deleting") {
			throw new Error("Activated collection deletion requires a fenced capture lifecycle");
		}
		if (!(await verifyMediaUsageCaptureTriggers(db, claim))) {
			throw new Error("Activated collection deletion requires the exact capture trigger set");
		}
		if (captureState === "active") {
			const result = await executeCollectionDeletionGuard(db, {
				action: "fence",
				collectionId: claim.collectionId,
				collectionSlug: claim.collectionSlug,
				leaseToken: claim.leaseToken,
				forceDelete: claim.forceDelete,
			});
			if (result.outcome === "has_content") {
				if (!(await repository.cancelFence(lease))) {
					throw new Error("Collection deletion lost its fence while preserving content");
				}
				return "has_content";
			}
			if (result.outcome !== "fenced") throw new Error("Collection deletion lost its fence");
		}
		if (
			!(await repository.checkpoint({
				...lease,
				fromPhase: "fence",
				toPhase: "registry",
			}))
		) {
			throw new Error("Collection deletion lost its fence checkpoint");
		}
		phase = "registry";
	}

	if (phase === "registry") {
		if (
			!(await repository.deleteRegistryAndCheckpoint({
				...lease,
				collectionSlug: claim.collectionSlug,
			}))
		) {
			throw new Error("Collection deletion lost its registry checkpoint");
		}
		phase = "table";
	}

	if (phase === "table") {
		const result = await executeCollectionDeletionGuard(db, {
			action: "drop",
			collectionId: claim.collectionId,
			collectionSlug: claim.collectionSlug,
			leaseToken: claim.leaseToken,
		});
		if (result.outcome !== "dropped") throw new Error("Collection deletion lost its table fence");
		if (
			!(await repository.checkpoint({
				...lease,
				fromPhase: "table",
				toPhase: "work",
			}))
		) {
			throw new Error("Collection deletion lost its table checkpoint");
		}
	}

	if (!(await repository.release(lease))) {
		throw new Error("Collection deletion lost its cleanup handoff");
	}
	return "deleted";
}

export async function isMediaUsageCollectionSlugDeleting(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<boolean> {
	validateIdentifier(collectionSlug, "collection slug");
	const row = await db
		.selectFrom("_emdash_media_usage_collection_deletions")
		.select("collection_id")
		.where("collection_slug", "=", collectionSlug)
		.executeTakeFirst();
	return row !== undefined;
}

async function assertActivatedCollectionDeletionReady(
	db: Kysely<Database>,
	identity: { collectionId: string; collectionSlug: string },
): Promise<void> {
	const captureState = await findCollectionCaptureState(db, identity);
	if (captureState !== "active") {
		throw new Error("Activated collection deletion requires an active capture lifecycle");
	}
	if (!(await verifyMediaUsageCaptureTriggers(db, identity))) {
		throw new Error("Activated collection deletion requires the exact capture trigger set");
	}
}

async function findCollectionCaptureState(
	db: Kysely<Database>,
	identity: { collectionId: string; collectionSlug: string },
): Promise<string | null> {
	const lifecycle = await db
		.selectFrom("_emdash_media_usage_index_status")
		.select("capture_state")
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", identity.collectionSlug)
		.where("collection_id", "=", identity.collectionId)
		.executeTakeFirst();
	return lifecycle?.capture_state ?? null;
}

async function executeCollectionDeletionGuard(
	db: Kysely<Database>,
	input: CollectionDeletionGuardInput,
): Promise<CollectionDeletionGuardResult> {
	const executeAdapterGuard = await loadAdapterCollectionDeletionGuard();
	if (executeAdapterGuard) {
		const { default: config } = await import("virtual:emdash/config");
		return executeAdapterGuard(config.database?.config, input);
	}
	return executeLocalCollectionDeletionGuard(db, input);
}

async function loadAdapterCollectionDeletionGuard(): Promise<
	import("../../db/adapters.js").ExecuteCollectionDeletionGuard | undefined
> {
	try {
		const dialect = await import("virtual:emdash/dialect");
		return dialect.executeCollectionDeletionGuard;
	} catch (error) {
		if (isVirtualDialectUnavailableError(error)) return undefined;
		throw error;
	}
}

export function isVirtualDialectUnavailableError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	if (error.code === "ERR_MODULE_NOT_FOUND") return error.message.includes(VIRTUAL_DIALECT_ID);
	return (
		error.code === "ERR_UNSUPPORTED_ESM_URL_SCHEME" &&
		error.message.includes("Received protocol 'virtual:'")
	);
}

export async function executeLocalCollectionDeletionGuard(
	db: Kysely<Database>,
	input: CollectionDeletionGuardInput,
): Promise<CollectionDeletionGuardResult> {
	assertGuardInput(input);
	return db.transaction().execute(async (trx) => {
		if (!(await lockLiveTombstone(trx, input))) return { outcome: "stale" };
		if (input.action === "fence") return fenceCollection(trx, input);

		const fts = new FTSManager(trx);
		await fts.dropFtsTable(input.collectionSlug);
		await sql`DROP TABLE IF EXISTS ${sql.ref(`ec_${input.collectionSlug}`)}`.execute(trx);
		return { outcome: "dropped" };
	});
}

async function fenceCollection(
	trx: Transaction<Database>,
	input: Extract<CollectionDeletionGuardInput, { action: "fence" }>,
): Promise<CollectionDeletionGuardResult> {
	const tableName = `ec_${input.collectionSlug}`;
	validateIdentifier(tableName, "content table");
	if (isPostgres(trx)) {
		await sql`LOCK TABLE ${sql.ref(tableName)} IN SHARE ROW EXCLUSIVE MODE`.execute(trx);
	}

	if (!input.forceDelete) {
		const content = await sql<{ present: number }>`
			SELECT 1 AS present FROM ${sql.ref(tableName)} LIMIT 1
		`.execute(trx);
		if (content.rows.length > 0) return { outcome: "has_content" };
	}

	const result = await trx
		.updateTable("_emdash_media_usage_index_status as status")
		.set({ capture_state: "deleting", updated_at: timestampOffset(trx, 0) })
		.where("status.adapter_id", "=", "content-media")
		.where("status.scope_type", "=", "collection")
		.where("status.scope_key", "=", input.collectionSlug)
		.where("status.collection_id", "=", input.collectionId)
		.where("status.capture_state", "=", "active")
		.where((eb) =>
			eb.exists(
				eb
					.selectFrom("_emdash_collections as collection")
					.select("collection.id")
					.where("collection.id", "=", input.collectionId)
					.where("collection.slug", "=", input.collectionSlug),
			),
		)
		.executeTakeFirst();
	return Number(result.numUpdatedRows ?? 0) === 1 ? { outcome: "fenced" } : { outcome: "stale" };
}

async function lockLiveTombstone(
	trx: Transaction<Database>,
	input: CollectionDeletionGuardInput,
): Promise<boolean> {
	const phase = input.action === "fence" ? "fence" : "table";
	if (isPostgres(trx)) {
		const row = await trx
			.selectFrom("_emdash_media_usage_collection_deletions")
			.select("collection_id")
			.where("collection_id", "=", input.collectionId)
			.where("collection_slug", "=", input.collectionSlug)
			.where("state", "=", "leased")
			.where("phase", "=", phase)
			.where("lease_token", "=", input.leaseToken)
			.where(liveLease(trx))
			.forUpdate()
			.executeTakeFirst();
		return row !== undefined;
	}

	const locked = await trx
		.updateTable("_emdash_media_usage_collection_deletions")
		.set({ updated_at: sql<string>`updated_at` })
		.where("collection_id", "=", input.collectionId)
		.where("collection_slug", "=", input.collectionSlug)
		.where("state", "=", "leased")
		.where("phase", "=", phase)
		.where("lease_token", "=", input.leaseToken)
		.where(liveLease(trx))
		.executeTakeFirst();
	return Number(locked.numUpdatedRows ?? 0) === 1;
}

function assertIdentity(input: { collectionId: string; collectionSlug: string }): void {
	if (!input.collectionId) throw new Error("Collection deletion requires a collection ID");
	validateIdentifier(input.collectionSlug, "collection slug");
}

function assertGuardInput(input: CollectionDeletionGuardInput): void {
	assertIdentity(input);
	if (!input.leaseToken) throw new Error("Collection deletion requires a lease token");
}

function liveLease(db: Kysely<Database>, column = "lease_expires_at"): RawBuilder<boolean> {
	const leaseExpiresAt = sql.ref(column);
	return isPostgres(db)
		? sql<boolean>`${leaseExpiresAt}::timestamptz > clock_timestamp()`
		: sql<boolean>`${leaseExpiresAt} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

function timestampIsDue(
	db: Kysely<Database>,
	column: "next_attempt_at" | "lease_expires_at",
): RawBuilder<boolean> {
	return isPostgres(db)
		? sql<boolean>`${sql.ref(column)}::timestamptz <= clock_timestamp()`
		: sql<boolean>`${sql.ref(column)} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
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

function rowToRecord(
	row: Selectable<MediaUsageCollectionDeletionTable>,
): MediaUsageCollectionDeletionRecord {
	if (!isState(row.state) || !isPhase(row.phase)) {
		throw new Error("Invalid media usage collection deletion lifecycle");
	}
	return {
		collectionId: row.collection_id,
		collectionSlug: row.collection_slug,
		forceDelete: Boolean(row.force_delete),
		state: row.state,
		phase: row.phase,
		workCursor: row.work_cursor,
		sourceKey: row.source_key,
		occurrenceCursor: row.occurrence_cursor,
		attemptCount: row.attempt_count,
		nextAttemptAt: row.next_attempt_at,
		leaseToken: row.lease_token,
		leaseExpiresAt: row.lease_expires_at,
		lastErrorCode: row.last_error_code,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function isState(value: string): value is MediaUsageCollectionDeletionState {
	return value === "pending" || value === "retry" || value === "leased" || value === "failed";
}

function isPhase(value: string): value is MediaUsageCollectionDeletionPhase {
	return (
		value === "fence" ||
		value === "registry" ||
		value === "table" ||
		value === "work" ||
		value === "sources" ||
		value === "status" ||
		value === "finalize"
	);
}
