import type { APIRoute } from "astro";
import { z } from "zod";

import { apiError, apiSuccess } from "#api/error.js";
import { isParseError, parseQuery } from "#api/parse.js";

import { SiteContentRepository } from "../../../../../../../../database/repositories/site-content.js";
import { SiteRepository } from "../../../../../../../../database/repositories/site.js";
import { TaxonomyRepository } from "../../../../../../../../database/repositories/taxonomy.js";

export const prerender = false;

const querySchema = z.object({
	collection: z.string().regex(/^[a-z][a-z0-9_]*$/),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const GET: APIRoute = async ({ locals, params, url }) => {
	const { emdash } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const query = parseQuery(url, querySchema);
	if (isParseError(query)) return query;

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site || site.status !== "active") return apiError("NOT_FOUND", "Site not found", 404);
		const term = await new TaxonomyRepository(emdash.db).findBySlug(
			params.name ?? "",
			params.slug ?? "",
		);
		if (!term) return apiError("NOT_FOUND", "Taxonomy term not found", 404);
		const items = await new SiteContentRepository(emdash.db).listPublishedByTaxonomy(
			site.id,
			query.collection,
			term.name,
			term.slug,
			query.limit,
		);
		if (items.length === 0) return apiError("NOT_FOUND", "Taxonomy term not found", 404);
		const response = apiSuccess({ term, items });
		response.headers.set("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=30");
		return response;
	} catch {
		return apiError("SITE_TAXONOMY_GET_ERROR", "Failed to load site taxonomy", 500);
	}
};
