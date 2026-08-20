import type { Kysely } from "kysely";

import { isPostgres } from "../../database/dialect-helpers.js";
import {
	MediaUsageWorkRepository,
	type MediaUsageWorkRecord,
} from "../../database/repositories/media-usage-work.js";
import { MediaUsageRepository } from "../../database/repositories/media-usage.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import {
	contentRefreshKey,
	refreshContentMediaUsageForWorkBatch,
	type ContentMediaUsageRefreshResult,
	type ContentMediaUsageRefreshErrorCode,
} from "./content-refresh.js";

export const MEDIA_USAGE_WORK_PROCESSING_LIMITS = Object.freeze({
	candidatesPerTick: 1_000,
	jobsPerTick: 1_000,
	maxTickDurationMs: 12 * 60_000,
	leaseDurationSeconds: 20 * 60,
	maxAttempts: 5,
	retryBaseSeconds: 30,
	retryMaxSeconds: 15 * 60,
	retryJitterRatio: 0.25,
});

export type MediaUsageWorkProcessingOutcome =
	| "inactive"
	| "not_due"
	| "claim_lost"
	| "completed"
	| "retry"
	| "failed"
	| "superseded"
	| "obsolete";

export interface MediaUsageWorkProcessingResult {
	outcome: MediaUsageWorkProcessingOutcome;
	claimed: boolean;
}

export interface MediaUsageWorkTickResult {
	candidateCount: number;
	claimedCount: number;
	completedCount: number;
	retryCount: number;
	failedCount: number;
	supersededCount: number;
	obsoleteCount: number;
	durationMs: number;
	admissionClosed: boolean;
}

export async function processMediaUsageWorkAfterWrite(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<MediaUsageWorkProcessingResult> {
	if (!(await isIncrementalCaptureActive(db))) {
		return { outcome: "inactive", claimed: false };
	}

	await new MediaUsageRepository(db).recoverIncrementalFinalizations();
	const repo = new MediaUsageWorkRepository(db);
	const work = await repo.findWorkForContent(collectionSlug, contentId);
	if (!work) return { outcome: "not_due", claimed: false };
	const claimed = await repo.claimWork({
		collectionId: work.collectionId,
		contentId: work.contentId,
		workVersion: work.workVersion,
		leaseDurationSeconds: MEDIA_USAGE_WORK_PROCESSING_LIMITS.leaseDurationSeconds,
	});
	if (!claimed) return { outcome: "claim_lost", claimed: false };
	try {
		const processed = await runClaimedBatch(
			db,
			[claimed],
			Date.now() + MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxTickDurationMs,
		);
		return processed.get(workResultKey(claimed)) ?? { outcome: "claim_lost", claimed: false };
	} catch (error) {
		const transitioned = await repo.retryClaimedWorkBatch({
			work: [workLease(claimed)],
			errorCode: "MEDIA_USAGE_PROCESSING_FAILED",
			retryDelaySeconds: MEDIA_USAGE_WORK_PROCESSING_LIMITS.retryBaseSeconds,
			maxAttempts: MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxAttempts,
		});
		const outcome = transitioned.get(workIdentityKey(claimed)) ?? "superseded";
		if (outcome === "failed") {
			await new MediaUsageRepository(db).recordIncrementalFailure({
				collectionId: claimed.collectionId,
				collectionSlug: claimed.collectionSlug,
				contentId: claimed.contentId,
				workVersion: claimed.workVersion,
				errorCode: "MEDIA_USAGE_PROCESSING_FAILED",
			});
		}
		console.error("[media-usage:work] Immediate processing failed:", error);
		return { outcome, claimed: true };
	}
}

export async function processDueMediaUsageWork(
	db: Kysely<Database>,
): Promise<MediaUsageWorkTickResult> {
	const startedAt = Date.now();
	const result: MediaUsageWorkTickResult = {
		candidateCount: 0,
		claimedCount: 0,
		completedCount: 0,
		retryCount: 0,
		failedCount: 0,
		supersededCount: 0,
		obsoleteCount: 0,
		durationMs: 0,
		admissionClosed: false,
	};

	if (!(await isIncrementalCaptureActive(db))) {
		result.durationMs = Date.now() - startedAt;
		return result;
	}

	await new MediaUsageRepository(db).recoverIncrementalFinalizations();
	const repo = new MediaUsageWorkRepository(db);
	const candidates = await repo.claimDueWorkBatch({
		limit: MEDIA_USAGE_WORK_PROCESSING_LIMITS.candidatesPerTick,
		leaseDurationSeconds: MEDIA_USAGE_WORK_PROCESSING_LIMITS.leaseDurationSeconds,
	});
	result.candidateCount =
		candidates.length > 0 || !(await repo.hasDueWork()) ? candidates.length : 1;

	let processedBatch: Map<string, MediaUsageWorkProcessingResult>;
	try {
		processedBatch = await runClaimedBatch(
			db,
			candidates,
			startedAt + MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxTickDurationMs,
		);
	} catch (error) {
		const transitioned = await repo.retryClaimedWorkBatch({
			work: candidates.map(workLease),
			errorCode: "MEDIA_USAGE_PROCESSING_FAILED",
			retryDelaySeconds: MEDIA_USAGE_WORK_PROCESSING_LIMITS.retryBaseSeconds,
			maxAttempts: MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxAttempts,
		});
		processedBatch = new Map();
		const usage = new MediaUsageRepository(db);
		const failedCollectionIds = new Set<string>();
		for (const candidate of candidates) {
			const state = transitioned.get(workIdentityKey(candidate));
			if (state === "failed") failedCollectionIds.add(candidate.collectionId);
			processedBatch.set(workResultKey(candidate), {
				outcome: state ?? "superseded",
				claimed: true,
			});
		}
		await usage.recordIncrementalFailuresByCollection({
			collectionIds: [...failedCollectionIds],
			errorCode: "MEDIA_USAGE_PROCESSING_FAILED",
		});
		console.error("[media-usage:work] Bulk processing failed:", error);
	}
	for (const candidate of candidates) {
		const processed = processedBatch.get(workResultKey(candidate)) ?? {
			outcome: "claim_lost" as const,
			claimed: false,
		};
		if (processed.claimed) result.claimedCount++;
		if (processed.outcome === "completed") result.completedCount++;
		if (processed.outcome === "retry") result.retryCount++;
		if (processed.outcome === "failed") result.failedCount++;
		if (processed.outcome === "superseded") result.supersededCount++;
		if (processed.outcome === "obsolete") result.obsoleteCount++;
	}

	result.durationMs = Date.now() - startedAt;
	return result;
}

async function runClaimedBatch(
	db: Kysely<Database>,
	candidates: readonly MediaUsageWorkRecord[],
	deadlineMs: number,
): Promise<Map<string, MediaUsageWorkProcessingResult>> {
	return isPostgres(db)
		? withTransaction(db, (trx) =>
				processClaimedBatch(trx, new MediaUsageWorkRepository(trx), candidates, deadlineMs),
			)
		: processClaimedBatch(db, new MediaUsageWorkRepository(db), candidates, deadlineMs);
}

async function processClaimedBatch(
	db: Kysely<Database>,
	repo: MediaUsageWorkRepository,
	candidates: readonly MediaUsageWorkRecord[],
	deadlineMs: number,
): Promise<Map<string, MediaUsageWorkProcessingResult>> {
	const results = new Map<string, MediaUsageWorkProcessingResult>();
	const locked = await repo.lockClaimedWorkBatch(candidates.map(workLease));
	const owned: MediaUsageWorkRecord[] = [];
	for (const candidate of candidates) {
		if (locked.has(workIdentityKey(candidate))) owned.push(candidate);
		else {
			results.set(workResultKey(candidate), { outcome: "superseded", claimed: true });
		}
	}
	const currentCollections = await findCurrentCollectionIdentities(db, owned);
	const current: MediaUsageWorkRecord[] = [];
	const obsolete: MediaUsageWorkRecord[] = [];
	for (const candidate of owned) {
		if (currentCollections.has(collectionResultKey(candidate))) current.push(candidate);
		else obsolete.push(candidate);
	}

	const obsoleteCompleted = await repo.completeWorkBatch(obsolete.map(workLease));
	for (const candidate of obsolete) {
		results.set(workResultKey(candidate), {
			outcome: obsoleteCompleted.has(workIdentityKey(candidate)) ? "obsolete" : "superseded",
			claimed: true,
		});
	}
	if (current.length === 0) return results;

	const refreshes = await refreshContentMediaUsageForWorkBatch(db, current, {
		shouldContinue: () => Date.now() < deadlineMs,
	});
	const successful: MediaUsageWorkRecord[] = [];
	const unstarted: MediaUsageWorkRecord[] = [];
	for (const candidate of current) {
		const refresh = refreshes.get(contentRefreshKey(candidate.collectionId, candidate.contentId));
		if (refresh?.success) successful.push(candidate);
		else if (!refresh) unstarted.push(candidate);
		else {
			results.set(
				workResultKey(candidate),
				await transitionClaimedFailure(db, repo, candidate, refresh ?? failedRefreshResult()),
			);
		}
	}
	const released = await repo.releaseClaimedWorkBatch(unstarted.map(workLease));
	for (const candidate of unstarted) {
		results.set(workResultKey(candidate), {
			outcome: released.has(workIdentityKey(candidate)) ? "not_due" : "superseded",
			claimed: true,
		});
	}

	const usage = new MediaUsageRepository(db);
	const successfulByCollection = new Map<string, MediaUsageWorkRecord[]>();
	for (const candidate of successful) {
		const key = collectionResultKey(candidate);
		const collection = successfulByCollection.get(key) ?? [];
		collection.push(candidate);
		successfulByCollection.set(key, collection);
	}
	const readyToComplete: MediaUsageWorkRecord[] = [];
	for (const collection of successfulByCollection.values()) {
		const first = collection[0];
		if (!first) continue;
		const finalization = await usage.prepareIncrementalFinalization({
			collectionId: first.collectionId,
			collectionSlug: first.collectionSlug,
		});
		if (finalization.outcome !== "lost") {
			readyToComplete.push(...collection);
			continue;
		}
		for (const candidate of collection) {
			results.set(
				workResultKey(candidate),
				await transitionClaimedFailure(db, repo, candidate, generationConflictResult()),
			);
		}
	}
	const completed = await repo.completeWorkBatch(readyToComplete.map(workLease));
	const completedCollections = new Map<string, MediaUsageWorkRecord>();
	for (const candidate of readyToComplete) {
		const didComplete = completed.has(workIdentityKey(candidate));
		results.set(workResultKey(candidate), {
			outcome: didComplete ? "completed" : "superseded",
			claimed: true,
		});
		if (didComplete) completedCollections.set(collectionResultKey(candidate), candidate);
	}
	for (const collection of completedCollections.values()) {
		await usage.recordIncrementalSuccess({
			collectionId: collection.collectionId,
			collectionSlug: collection.collectionSlug,
		});
	}
	return results;
}

async function transitionClaimedFailure(
	db: Kysely<Database>,
	repo: MediaUsageWorkRepository,
	claimed: MediaUsageWorkRecord,
	refresh: ContentMediaUsageRefreshResult,
): Promise<MediaUsageWorkProcessingResult> {
	if (!claimed.leaseToken) return { outcome: "claim_lost", claimed: false };
	const lease = workLease(claimed);

	if (!(await collectionIdentityIsCurrent(db, claimed.collectionId, claimed.collectionSlug))) {
		return {
			outcome: (await repo.completeWork(lease)) ? "obsolete" : "superseded",
			claimed: true,
		};
	}

	const errorCode = processingErrorCode(refresh.errorCode);
	const terminal =
		errorCode === "MEDIA_USAGE_RESOURCE_LIMIT" ||
		claimed.attemptCount + 1 >= MEDIA_USAGE_WORK_PROCESSING_LIMITS.maxAttempts;
	if (terminal) {
		const failed = await repo.failWork({ ...lease, errorCode });
		if (failed) {
			await new MediaUsageRepository(db).recordIncrementalFailure({
				collectionId: claimed.collectionId,
				collectionSlug: claimed.collectionSlug,
				contentId: claimed.contentId,
				workVersion: claimed.workVersion,
				errorCode,
			});
		}
		return {
			outcome: failed ? "failed" : "superseded",
			claimed: true,
		};
	}

	return {
		outcome: (await repo.retryWork({
			...lease,
			errorCode,
			retryDelaySeconds: retryDelaySeconds(claimed.attemptCount),
		}))
			? "retry"
			: "superseded",
		claimed: true,
	};
}

async function findCurrentCollectionIdentities(
	db: Kysely<Database>,
	candidates: readonly MediaUsageWorkRecord[],
): Promise<Set<string>> {
	const identities = new Map(
		candidates.map((candidate) => [collectionResultKey(candidate), candidate] as const),
	);
	const current = new Set<string>();
	for (const batch of chunkCollectionIds(
		Array.from(identities.values(), (item) => item.collectionId),
	)) {
		const rows = await db
			.selectFrom("_emdash_collections")
			.select(["id", "slug"])
			.where("id", "in", batch)
			.execute();
		for (const row of rows) current.add(`${row.id}\u0000${row.slug}`);
	}
	return current;
}

function workLease(work: MediaUsageWorkRecord) {
	if (!work.leaseToken) throw new Error("Claimed media usage work requires a lease token");
	return {
		collectionId: work.collectionId,
		contentId: work.contentId,
		workVersion: work.workVersion,
		leaseToken: work.leaseToken,
	};
}

function workIdentityKey(work: MediaUsageWorkRecord): string {
	return `${work.collectionId}\u0000${work.contentId}\u0000${String(work.workVersion)}`;
}

function workResultKey(work: MediaUsageWorkRecord): string {
	return workIdentityKey(work);
}

function collectionResultKey(work: Pick<MediaUsageWorkRecord, "collectionId" | "collectionSlug">) {
	return `${work.collectionId}\u0000${work.collectionSlug}`;
}

function chunkCollectionIds(ids: readonly string[]): string[][] {
	const unique = [...new Set(ids)];
	const batches: string[][] = [];
	for (let index = 0; index < unique.length; index += 50) {
		batches.push(unique.slice(index, index + 50));
	}
	return batches;
}

function failedRefreshResult(): ContentMediaUsageRefreshResult {
	return {
		success: false,
		refreshedSourceCount: 0,
		deletedSourceCount: 0,
		failedSourceCount: 0,
		errorCode: "CONTENT_USAGE_REFRESH_ERROR",
	};
}

function generationConflictResult(): ContentMediaUsageRefreshResult {
	return {
		success: false,
		refreshedSourceCount: 0,
		deletedSourceCount: 0,
		failedSourceCount: 0,
		errorCode: "CONTENT_USAGE_GENERATION_CONFLICT",
	};
}

async function isIncrementalCaptureActive(db: Kysely<Database>): Promise<boolean> {
	const row = await db
		.selectFrom("_emdash_media_usage_activation")
		.select("state")
		.where("task_key", "=", "incremental_capture")
		.executeTakeFirst();
	return row?.state === "active";
}

async function collectionIdentityIsCurrent(
	db: Kysely<Database>,
	collectionId: string,
	collectionSlug: string,
): Promise<boolean> {
	const row = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("id", "=", collectionId)
		.where("slug", "=", collectionSlug)
		.executeTakeFirst();
	return row !== undefined;
}

function retryDelaySeconds(attemptCount: number): number {
	const exponential = Math.min(
		MEDIA_USAGE_WORK_PROCESSING_LIMITS.retryMaxSeconds,
		MEDIA_USAGE_WORK_PROCESSING_LIMITS.retryBaseSeconds * 2 ** attemptCount,
	);
	const jitter = Math.floor(
		exponential * MEDIA_USAGE_WORK_PROCESSING_LIMITS.retryJitterRatio * Math.random(),
	);
	return Math.min(MEDIA_USAGE_WORK_PROCESSING_LIMITS.retryMaxSeconds, exponential + jitter);
}

function processingErrorCode(errorCode: ContentMediaUsageRefreshErrorCode | undefined): string {
	if (
		errorCode === "DRAFT_REVISION_NOT_FOUND" ||
		errorCode === "DRAFT_REVISION_MISMATCH" ||
		errorCode === "DRAFT_REVISION_INVALID"
	) {
		return "MEDIA_USAGE_SNAPSHOT_FAILED";
	}
	if (errorCode === "CONTENT_USAGE_GENERATION_CONFLICT") {
		return "MEDIA_USAGE_GENERATION_CONFLICT";
	}
	if (errorCode === "CONTENT_USAGE_RESOURCE_LIMIT") return "MEDIA_USAGE_RESOURCE_LIMIT";
	return "MEDIA_USAGE_PROCESSING_FAILED";
}
