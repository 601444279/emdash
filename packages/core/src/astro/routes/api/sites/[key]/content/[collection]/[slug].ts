import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, unwrapResult } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { contentUpdateBody } from "#api/schemas.js";

import { SiteContentRepository } from "../../../../../../../database/repositories/site-content.js";
import { SiteRepository } from "../../../../../../../database/repositories/site.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	const denied = requirePerm(user, "content:read");
	if (denied) return denied;

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site || site.status !== "active") return apiError("NOT_FOUND", "Site not found", 404);
		const item = await new SiteContentRepository(emdash.db).findByIdentifier(
			site.id,
			params.collection ?? "",
			params.slug ?? "",
		);
		if (!item || (item.status !== "published" && !hasPermission(user, "content:read_drafts"))) {
			return apiError("NOT_FOUND", "Content not found", 404);
		}
		return apiSuccess({ item });
	} catch {
		return apiError("SITE_CONTENT_GET_ERROR", "Failed to load site content", 500);
	}
};

export const PUT: APIRoute = async ({ cache, locals, params, request }) => {
	const { emdash, user } = locals;
	if (!emdash?.db || !emdash.handleContentUpdate) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const body = await parseBody(request, contentUpdateBody);
	if (isParseError(body)) return body;

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site || site.status !== "active") return apiError("NOT_FOUND", "Site not found", 404);
		const item = await new SiteContentRepository(emdash.db).findByIdentifier(
			site.id,
			params.collection ?? "",
			params.slug ?? "",
		);
		if (!item) return apiError("NOT_FOUND", "Content not found", 404);

		const denied = requireOwnerPerm(
			user,
			item.authorId ?? "",
			"content:edit_own",
			"content:edit_any",
		);
		if (denied) return denied;
		if (body.publishedAt !== undefined && !hasPermission(user, "content:publish_any")) {
			return apiError(
				"FORBIDDEN",
				"Writing publishedAt requires content:publish_any permission",
				403,
			);
		}

		const updateBody =
			body.authorId !== undefined && !hasPermission(user, "content:edit_any")
				? { ...body, authorId: undefined }
				: body;
		const result = await emdash.handleContentUpdate(params.collection ?? "", item.id, {
			...updateBody,
			_rev: body._rev,
		});
		if (result.success && cache?.enabled && result.liveContentChanged !== false) {
			await cache.invalidate({ tags: [`site:${site.key}:${item.type}`] });
		}
		return unwrapResult(result);
	} catch {
		return apiError("SITE_CONTENT_UPDATE_ERROR", "Failed to update site content", 500);
	}
};

export const DELETE: APIRoute = async ({ cache, locals, params }) => {
	const { emdash, user } = locals;
	if (!emdash?.db || !emdash.handleContentDelete) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site || site.status !== "active") return apiError("NOT_FOUND", "Site not found", 404);
		const item = await new SiteContentRepository(emdash.db).findByIdentifier(
			site.id,
			params.collection ?? "",
			params.slug ?? "",
		);
		if (!item) return apiError("NOT_FOUND", "Content not found", 404);

		const denied = requireOwnerPerm(
			user,
			item.authorId ?? "",
			"content:delete_own",
			"content:delete_any",
		);
		if (denied) return denied;
		const result = await emdash.handleContentDelete(params.collection ?? "", item.id);
		if (result.success && cache?.enabled) {
			await cache.invalidate({ tags: [`site:${site.key}:${item.type}`] });
		}
		return unwrapResult(result);
	} catch {
		return apiError("SITE_CONTENT_DELETE_ERROR", "Failed to delete site content", 500);
	}
};
