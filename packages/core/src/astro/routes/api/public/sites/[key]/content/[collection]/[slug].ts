import type { APIRoute } from "astro";

import { apiError, apiSuccess } from "#api/error.js";

import { SiteContentRepository } from "../../../../../../../../database/repositories/site-content.js";
import { SiteRepository } from "../../../../../../../../database/repositories/site.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
	const { emdash } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site || site.status !== "active") return apiError("NOT_FOUND", "Site not found", 404);
		const item = await new SiteContentRepository(emdash.db).findBySlug(
			site.id,
			params.collection ?? "",
			params.slug ?? "",
		);
		if (item?.status !== "published") return apiError("NOT_FOUND", "Content not found", 404);
		const response = apiSuccess({ item });
		response.headers.set(
			"Cache-Control",
			"public, max-age=0, s-maxage=60, stale-while-revalidate=30",
		);
		return response;
	} catch {
		return apiError("SITE_CONTENT_GET_ERROR", "Failed to load site content", 500);
	}
};
