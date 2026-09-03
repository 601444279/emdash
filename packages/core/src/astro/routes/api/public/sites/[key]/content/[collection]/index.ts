import type { APIRoute } from "astro";
import { z } from "zod";

import { apiError, apiSuccess } from "#api/error.js";
import { isParseError, parseQuery } from "#api/parse.js";

import { SiteContentRepository } from "../../../../../../../../database/repositories/site-content.js";
import { SiteRepository } from "../../../../../../../../database/repositories/site.js";

export const prerender = false;

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

export const GET: APIRoute = async ({ locals, params, url }) => {
	const { emdash } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const query = parseQuery(url, listQuery);
	if (isParseError(query)) return query;

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site || site.status !== "active") return apiError("NOT_FOUND", "Site not found", 404);
		const items = await new SiteContentRepository(emdash.db).listPublished(
			site.id,
			params.collection ?? "",
			query.limit,
		);
		const response = apiSuccess({ items });
		response.headers.set(
			"Cache-Control",
			"public, max-age=0, s-maxage=60, stale-while-revalidate=30",
		);
		return response;
	} catch {
		return apiError("SITE_CONTENT_LIST_ERROR", "Failed to list site content", 500);
	}
};
