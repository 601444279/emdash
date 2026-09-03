import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { contentCreateBody } from "#api/schemas.js";

import { SiteContentRepository } from "../../../../../../../database/repositories/site-content.js";
import { SiteRepository } from "../../../../../../../database/repositories/site.js";

export const prerender = false;

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

export const GET: APIRoute = async ({ locals, params, url }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const denied = requirePerm(user, "content:read");
	if (denied) return denied;

	const query = parseQuery(url, listQuery);
	if (isParseError(query)) return query;

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site || site.status !== "active") return apiError("NOT_FOUND", "Site not found", 404);
		const items = await new SiteContentRepository(emdash.db).list(
			site.id,
			params.collection ?? "",
			query.limit,
			!hasPermission(user, "content:read_drafts"),
		);
		return Response.json(
			{ success: true, data: { items } },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch {
		return apiError("SITE_CONTENT_LIST_ERROR", "Failed to list site content", 500);
	}
};

export const POST: APIRoute = async ({ cache, locals, params, request }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const denied = requirePerm(user, "content:create");
	if (denied) return denied;
	const body = await parseBody(request, contentCreateBody);
	if (isParseError(body)) return body;

	if (
		(body.publishedAt !== undefined || body.createdAt !== undefined) &&
		!hasPermission(user, "content:publish_any")
	) {
		return apiError(
			"FORBIDDEN",
			"Writing publishedAt or createdAt requires content:publish_any permission",
			403,
		);
	}

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site || site.status !== "active") return apiError("NOT_FOUND", "Site not found", 404);
		const item = await new SiteContentRepository(emdash.db).create(site.id, {
			...body,
			type: params.collection ?? "",
			authorId: user?.id,
		});
		if (cache?.enabled) await cache.invalidate({ tags: [`site:${site.key}:${item.type}`] });
		return unwrapResult({ success: true, data: { item } }, 201);
	} catch (error) {
		if (error instanceof Error && error.message === "SITE_CONTENT_NOT_FOUND") {
			return apiError("NOT_FOUND", "Translation source content not found", 404);
		}
		return apiError("SITE_CONTENT_CREATE_ERROR", "Failed to create site content", 500);
	}
};
