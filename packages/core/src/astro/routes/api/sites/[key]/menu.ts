import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";

import { MenuRepository } from "../../../../../database/repositories/menu.js";
import { SiteMenuRepository } from "../../../../../database/repositories/site-menu.js";
import { SiteRepository } from "../../../../../database/repositories/site.js";

export const prerender = false;

const assignMenuSchema = z.object({
	menuId: z.string().min(1),
});

export const GET: APIRoute = async ({ locals, params }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site) return apiError("NOT_FOUND", "Site not found", 404);
		const menu = await new SiteMenuRepository(emdash.db).find(site.id);
		return apiSuccess({ menuId: menu?.id ?? null });
	} catch (error) {
		return handleError(error, "Failed to load site menu", "SITE_MENU_GET_ERROR");
	}
};

export const PUT: APIRoute = async ({ request, locals, params }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	const body = await parseBody(request, assignMenuSchema);
	if (isParseError(body)) return body;

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site) return apiError("NOT_FOUND", "Site not found", 404);
		const menu = await new MenuRepository(emdash.db).findById(body.menuId);
		if (!menu) return apiError("NOT_FOUND", "Menu not found", 404);
		await new SiteMenuRepository(emdash.db).assign(site.id, menu.id);
		return apiSuccess({ menuId: menu.id });
	} catch (error) {
		return handleError(error, "Failed to assign site menu", "SITE_MENU_ASSIGN_ERROR");
	}
};
