import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";

import { SiteRepository } from "../../../../../../../database/repositories/site.js";

export const prerender = false;

export const POST: APIRoute = async ({ locals, params }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		const sites = new SiteRepository(emdash.db);
		const site = await sites.findByKey(params.key ?? "");
		if (!site) return apiError("NOT_FOUND", "Site not found", 404);
		const restored = await sites.rollbackTheme(site.id, params.historyId ?? "");
		return restored
			? apiSuccess(restored)
			: apiError("NOT_FOUND", "Theme history entry not found", 404);
	} catch (error) {
		return handleError(error, "Failed to roll back theme", "SITE_THEME_ROLLBACK_ERROR");
	}
};
