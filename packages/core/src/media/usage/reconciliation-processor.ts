import type { Kysely } from "kysely";

import { MediaUsageWorkRepository } from "../../database/repositories/media-usage-work.js";
import type { Database } from "../../database/types.js";
import {
	buildContentMediaUsageFieldFingerprint,
	loadContentMediaUsageFields,
} from "./content-fields.js";
import {
	MediaUsageReconciliationRepository,
	type MediaUsageReconciliationClaim,
} from "./reconciliation.js";

export type MediaUsageReconciliationScanOutcome = "advanced" | "exhausted" | "deferred";

export async function processClaimedMediaUsageReconciliationScan(
	db: Kysely<Database>,
	claim: MediaUsageReconciliationClaim,
): Promise<MediaUsageReconciliationScanOutcome> {
	const reconciliation = new MediaUsageReconciliationRepository(db);
	let current = await reconciliation.findByIdentity(claim.collectionId, claim.runToken);
	if (!current || current.leaseToken !== claim.leaseToken || current.phase !== "scan") {
		return "deferred";
	}

	let fields;
	let fieldFingerprint: string;
	if (current.targetEpoch === null) {
		const targetEpoch = await reconciliation.beginRun(claim);
		if (targetEpoch === null) {
			await reconciliation.release({ ...claim, delaySeconds: 30 });
			return "deferred";
		}
		fields = await loadContentMediaUsageFields(db, claim.collectionSlug, claim.collectionId);
		fieldFingerprint = await buildContentMediaUsageFieldFingerprint(fields);
		const scanUpperId =
			fields.extractionFields.length === 0 ? null : await reconciliation.findScanUpperId(claim);
		if (
			!(await reconciliation.initializeScan({
				claim,
				targetEpoch,
				fieldFingerprint,
				scanUpperId,
			}))
		) {
			return "deferred";
		}
		current = await reconciliation.findByIdentity(claim.collectionId, claim.runToken);
		if (!current) return "deferred";
	} else {
		fields = await loadContentMediaUsageFields(db, claim.collectionSlug, claim.collectionId);
		fieldFingerprint = await buildContentMediaUsageFieldFingerprint(fields);
	}

	if (current.fieldFingerprint !== fieldFingerprint || current.targetEpoch === null) {
		await reconciliation.release({ ...claim, delaySeconds: 30 });
		return "deferred";
	}
	const contentIds = await reconciliation.findScanPage(current, 50);
	if (contentIds.length === 0) {
		await reconciliation.release({ ...claim, delaySeconds: 30 });
		return "exhausted";
	}

	const work = new MediaUsageWorkRepository(db);
	await work.enqueueReconciliationPage({
		collectionId: claim.collectionId,
		collectionSlug: claim.collectionSlug,
		runToken: claim.runToken,
		leaseToken: claim.leaseToken,
		changeEpoch: current.targetEpoch,
		contentIds,
	});
	const nextCursor = contentIds.at(-1)!;
	if (
		!(await reconciliation.checkpointScan({
			claim,
			targetEpoch: current.targetEpoch,
			previousCursor: current.scanCursor,
			nextCursor,
		}))
	) {
		return "deferred";
	}
	if (!(await reconciliation.release({ ...claim, delaySeconds: 0 }))) return "deferred";
	return "advanced";
}
