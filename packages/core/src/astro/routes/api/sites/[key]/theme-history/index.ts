import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";

import { SiteRepository } from "../../../../../../database/repositories/site.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		const sites = new SiteRepository(emdash.db);
		const site = await sites.findByKey(params.key ?? "");
		if (!site) return apiError("NOT_FOUND", "Site not found", 404);
		return apiSuccess({ items: await sites.listThemeHistory(site.id) });
	} catch (error) {
		return handleError(error, "Failed to load theme history", "SITE_THEME_HISTORY_ERROR");
	}
};
