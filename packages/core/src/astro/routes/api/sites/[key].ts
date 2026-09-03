import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { SiteRepository } from "../../../../database/repositories/site.js";
import { validateThemeSettings } from "../../../../themes/index.js";

export const prerender = false;

const themeSchema = z.object({
	id: z.string().min(1),
	version: z.string().min(1),
	settings: z.record(z.string(), z.unknown()),
});

const updateSiteSchema = z.object({
	name: z.string().trim().min(1).optional(),
	status: z.enum(["active", "archived"]).optional(),
	domains: z.array(z.string()).max(20).optional(),
	theme: themeSchema.optional(),
});

export const GET: APIRoute = async ({ locals, params }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		return site ? apiSuccess(site) : apiError("NOT_FOUND", "Site not found", 404);
	} catch (error) {
		return handleError(error, "Failed to load site", "SITE_GET_ERROR");
	}
};

export const PATCH: APIRoute = async ({ request, locals, params }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	const body = await parseBody(request, updateSiteSchema);
	if (isParseError(body)) return body;

	try {
		const sites = new SiteRepository(emdash.db);
		const current = await sites.findByKey(params.key ?? "");
		if (!current) return apiError("NOT_FOUND", "Site not found", 404);
		const theme = body.theme
			? {
					...body.theme,
					settings: validateThemeSettings(body.theme.id, body.theme.version, body.theme.settings),
				}
			: undefined;
		const site = await sites.update(current.id, { ...body, theme });
		return apiSuccess(site);
	} catch (error) {
		if (error instanceof Error && error.message === "SITE_DOMAIN_CONFLICT") {
			return apiError("SITE_DOMAIN_CONFLICT", "This domain is already assigned to a site", 409);
		}
		if (
			error instanceof Error &&
			["INVALID_SITE_DOMAIN", "THEME_NOT_FOUND", "INVALID_THEME_SETTINGS"].includes(error.message)
		) {
			return apiError(error.message, "Invalid site configuration", 400);
		}
		return handleError(error, "Failed to update site", "SITE_UPDATE_ERROR");
	}
};
