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

const createSiteSchema = z.object({
	key: z.string().min(1),
	name: z.string().trim().min(1),
	domains: z.array(z.string()).max(20),
	theme: themeSchema,
});

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		return apiSuccess(await new SiteRepository(emdash.db).list());
	} catch (error) {
		return handleError(error, "Failed to list sites", "SITE_LIST_ERROR");
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	const body = await parseBody(request, createSiteSchema);
	if (isParseError(body)) return body;

	try {
		const settings = validateThemeSettings(body.theme.id, body.theme.version, body.theme.settings);
		const site = await new SiteRepository(emdash.db).create({
			...body,
			theme: { ...body.theme, settings },
		});
		return apiSuccess(site, 201);
	} catch (error) {
		if (error instanceof Error && error.message === "SITE_DOMAIN_CONFLICT") {
			return apiError("SITE_DOMAIN_CONFLICT", "This domain is already assigned to a site", 409);
		}
		if (
			error instanceof Error &&
			[
				"INVALID_SITE_KEY",
				"INVALID_SITE_DOMAIN",
				"THEME_NOT_FOUND",
				"INVALID_THEME_SETTINGS",
			].includes(error.message)
		) {
			return apiError(error.message, "Invalid site configuration", 400);
		}
		return handleError(error, "Failed to create site", "SITE_CREATE_ERROR");
	}
};
