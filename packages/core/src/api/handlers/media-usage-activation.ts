import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import {
	getMediaUsageActivationStatus,
	MediaUsageActivationVersionMismatchError,
} from "../../media/usage/activation.js";
import { ErrorCode } from "../errors.js";
import type { MediaUsageActivationStatus } from "../schemas/media-usage.js";
import type { ApiResult } from "../types.js";

export async function handleMediaUsageActivationStatus(
	db: Kysely<Database>,
): Promise<ApiResult<MediaUsageActivationStatus>> {
	try {
		return { success: true, data: await getMediaUsageActivationStatus(db) };
	} catch (error) {
		if (error instanceof MediaUsageActivationVersionMismatchError) {
			return {
				success: false,
				error: {
					code: ErrorCode.MEDIA_USAGE_ACTIVATION_VERSION_MISMATCH,
					message: "Media usage activation version is incompatible with this runtime",
				},
			};
		}
		console.error("[media-usage:activation] status read failed:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.MEDIA_USAGE_ACTIVATION_READ_ERROR,
				message: "Failed to read media usage activation status",
			},
		};
	}
}
