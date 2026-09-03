import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess } from "#api/error.js";
import { listThemes } from "../../../../themes/index.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const denied = requirePerm(locals.user, "settings:manage");
	if (denied) return denied;
	if (!locals.emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	return apiSuccess(listThemes());
};
