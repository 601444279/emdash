import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { getRequestContext } from "../../request-context.js";
import {
	continueMediaUsageActivation,
	MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION,
	MediaUsageActivationVersionMismatchError,
} from "./activation.js";
import { processDueMediaUsageCollectionDeletions } from "./collection-deletion-processor.js";
import { processDueMediaUsageReconciliationDetailed } from "./reconciliation-processor.js";
import { MediaUsageReconciliationRepository } from "./reconciliation.js";
import { processDueMediaUsageWork } from "./work-processor.js";

export type MediaUsageMaintenanceTaskClass =
	| "entry_work"
	| "collection_deletion"
	| "reconciliation";

export type MediaUsageMaintenanceContinuation =
	| { kind: "none" }
	| { kind: "immediate" }
	| { kind: "delayed"; delaySeconds: 30 };

export interface MediaUsageMaintenanceStepResult {
	state: "inactive" | "idle" | "blocked" | "progress";
	continuation: MediaUsageMaintenanceContinuation;
	taskClass: MediaUsageMaintenanceTaskClass | null;
	turn: number | null;
}

export const MEDIA_USAGE_MAINTENANCE_LIMITS = Object.freeze({
	eventQueryCeiling: 900,
	maxStepQueries: 150,
	stepStartDeadlineMs: 14 * 60_000,
});

const TASK_CLASSES: readonly MediaUsageMaintenanceTaskClass[] = [
	"collection_deletion",
	"entry_work",
	"reconciliation",
];

const TASK_CLASS_TURNS: Record<MediaUsageMaintenanceTaskClass, number> = {
	entry_work: 0,
	collection_deletion: 1,
	reconciliation: 2,
};

export async function runMediaUsageMaintenanceStep(
	db: Kysely<Database>,
): Promise<MediaUsageMaintenanceStepResult> {
	const activation = await db
		.selectFrom("_emdash_media_usage_activation")
		.select(["state", "runtime_generation"])
		.where("task_key", "=", "incremental_capture")
		.executeTakeFirst();
	if (
		activation?.state !== "active" ||
		activation.runtime_generation !== MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION
	) {
		return runActivationStep(db);
	}

	let firstBlocked: { taskClass: MediaUsageMaintenanceTaskClass; turn: number } | null = null;
	let blockedReconciliationTurn: number | null = null;
	let firstProgress: { taskClass: MediaUsageMaintenanceTaskClass; turn: number } | null = null;

	for (const taskClass of TASK_CLASSES) {
		const turn = TASK_CLASS_TURNS[taskClass];
		const metrics = getRequestContext()?.metrics;
		if (metrics && !canStartMediaUsageMaintenanceStep(metrics)) {
			return firstProgress
				? {
						state: "progress",
						continuation: { kind: "immediate" },
						...firstProgress,
					}
				: {
						state: "blocked",
						continuation: { kind: "immediate" },
						taskClass,
						turn,
					};
		}
		const outcome = await runTaskClass(db, taskClass);
		if (outcome === "inactive") return inactiveResult();
		if (outcome === "progress" && !firstProgress) firstProgress = { taskClass, turn };
		if (outcome === "blocked") {
			if (!firstBlocked) firstBlocked = { taskClass, turn };
			if (taskClass === "reconciliation") blockedReconciliationTurn = turn;
		}
	}
	if (firstProgress) {
		return {
			state: "progress",
			continuation: { kind: "immediate" },
			...firstProgress,
		};
	}

	if (
		blockedReconciliationTurn !== null &&
		(await new MediaUsageReconciliationRepository(db).wakeDrainedBarrierCandidate())
	) {
		return {
			state: "progress",
			continuation: { kind: "immediate" },
			taskClass: "reconciliation",
			turn: blockedReconciliationTurn,
		};
	}

	if (firstBlocked) {
		return {
			state: "blocked",
			continuation: { kind: "delayed", delaySeconds: 30 },
			...firstBlocked,
		};
	}

	return {
		state: "idle",
		continuation: { kind: "none" },
		taskClass: TASK_CLASSES[0],
		turn: TASK_CLASS_TURNS[TASK_CLASSES[0]],
	};
}

async function runActivationStep(db: Kysely<Database>): Promise<MediaUsageMaintenanceStepResult> {
	try {
		const result = await continueMediaUsageActivation(db);
		if (result.outcome === "activating" || result.outcome === "active") {
			return {
				state: "progress",
				continuation: { kind: "immediate" },
				taskClass: null,
				turn: null,
			};
		}
		if (result.outcome === "lease_active" || result.outcome === "conflict") {
			return {
				state: "blocked",
				continuation: { kind: "delayed", delaySeconds: 30 },
				taskClass: null,
				turn: null,
			};
		}
		return inactiveResult();
	} catch (error) {
		if (error instanceof MediaUsageActivationVersionMismatchError) return inactiveResult();
		throw error;
	}
}

export async function runMediaUsageMaintenanceSlice(
	db: Kysely<Database>,
): Promise<MediaUsageMaintenanceContinuation> {
	const metrics = getRequestContext()?.metrics;
	if (!metrics) return (await runMediaUsageMaintenanceStep(db)).continuation;

	let madeProgress = false;
	let recordedDbCount = metrics.dbCount;
	while (canStartMediaUsageMaintenanceStep(metrics)) {
		const result = await runMediaUsageMaintenanceStep(db);
		if (result.continuation.kind !== "immediate") return result.continuation;
		madeProgress = true;
		if (metrics.dbCount === recordedDbCount) return { kind: "immediate" };
		recordedDbCount = metrics.dbCount;
	}

	return madeProgress ? { kind: "immediate" } : { kind: "none" };
}

async function runTaskClass(
	db: Kysely<Database>,
	taskClass: MediaUsageMaintenanceTaskClass,
): Promise<"inactive" | "idle" | "blocked" | "progress"> {
	if (taskClass === "entry_work") {
		const result = await processDueMediaUsageWork(db);
		if (result.claimedCount > 0) return "progress";
		return result.candidateCount > 0 ? "blocked" : "idle";
	}
	if (taskClass === "collection_deletion") {
		const result = await processDueMediaUsageCollectionDeletions(db);
		if (result.claimedCount > 0) return "progress";
		return result.candidateCount > 0 ? "blocked" : "idle";
	}

	const result = await processDueMediaUsageReconciliationDetailed(db);
	if (result.outcome === "inactive") return "inactive";
	if (result.consumedUnit) return "progress";
	return result.outcome === "claim_lost" || result.hasDeferredCandidate ? "blocked" : "idle";
}

function inactiveResult(): MediaUsageMaintenanceStepResult {
	return {
		state: "inactive",
		continuation: { kind: "none" },
		taskClass: null,
		turn: null,
	};
}

function canStartMediaUsageMaintenanceStep(metrics: { start: number; dbCount: number }): boolean {
	return (
		metrics.dbCount + MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries <=
			MEDIA_USAGE_MAINTENANCE_LIMITS.eventQueryCeiling &&
		performance.now() - metrics.start < MEDIA_USAGE_MAINTENANCE_LIMITS.stepStartDeadlineMs
	);
}
