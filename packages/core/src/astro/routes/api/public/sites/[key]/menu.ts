import type { APIRoute } from "astro";

import { apiError, apiSuccess } from "#api/error.js";

import { SiteMenuRepository } from "../../../../../../database/repositories/site-menu.js";
import { SiteRepository } from "../../../../../../database/repositories/site.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
	const { emdash } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site || site.status !== "active") return apiError("NOT_FOUND", "Site not found", 404);
		const menu = await new SiteMenuRepository(emdash.db).find(site.id);
		const items = (menu?.items ?? [])
			.filter(
				(item) =>
					item.type === "custom" &&
					item.customUrl?.startsWith("/") &&
					!item.customUrl.startsWith("//"),
			)
			.map((item) => ({ label: item.label, href: item.customUrl! }));
		const response = apiSuccess({ items });
		response.headers.set(
			"Cache-Control",
			"public, max-age=0, s-maxage=60, stale-while-revalidate=30",
		);
		return response;
	} catch {
		return apiError("SITE_MENU_GET_ERROR", "Failed to load site menu", 500);
	}
};
