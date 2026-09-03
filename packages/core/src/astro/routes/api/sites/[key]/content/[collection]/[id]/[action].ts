import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requireOwnerPerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { contentPublishBody } from "#api/schemas.js";

import { SiteContentRepository } from "../../../../../../../../database/repositories/site-content.js";
import { SiteRepository } from "../../../../../../../../database/repositories/site.js";

export const prerender = false;

export const POST: APIRoute = async ({ cache, locals, params, request }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const action = params.action;
	if (action !== "publish" && action !== "unpublish" && action !== "discard-draft") {
		return apiError("NOT_FOUND", "Site content action not found", 404);
	}

	try {
		const site = await new SiteRepository(emdash.db).findByKey(params.key ?? "");
		if (!site || site.status !== "active") return apiError("NOT_FOUND", "Site not found", 404);
		const item = await new SiteContentRepository(emdash.db).findByIdentifier(
			site.id,
			params.collection ?? "",
			params.id ?? "",
		);
		if (!item) return apiError("NOT_FOUND", "Content not found", 404);

		const permission =
			action === "publish" || action === "unpublish"
				? requireOwnerPerm(user, item.authorId ?? "", "content:publish_own", "content:publish_any")
				: requireOwnerPerm(user, item.authorId ?? "", "content:edit_own", "content:edit_any");
		if (permission) return permission;

		let result;
		if (action === "publish") {
			if (!emdash.handleContentPublish) {
				return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
			}
			const body = await parseOptionalBody(request, contentPublishBody, {});
			if (isParseError(body)) return body;
			if (body.publishedAt !== undefined && !hasPermission(user, "content:publish_any")) {
				return apiError("FORBIDDEN", "Setting publishedAt requires content:publish_any permission", 403);
			}
			result = await emdash.handleContentPublish(params.collection ?? "", item.id, {
				publishedAt: body.publishedAt,
			});
		} else if (action === "unpublish") {
			if (!emdash.handleContentUnpublish) {
				return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
			}
			result = await emdash.handleContentUnpublish(params.collection ?? "", item.id);
		} else {
			if (!emdash.handleContentDiscardDraft) {
				return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
			}
			result = await emdash.handleContentDiscardDraft(params.collection ?? "", item.id);
		}

		if (result.success && cache?.enabled) {
			await cache.invalidate({ tags: [`site:${site.key}:${item.type}`] });
		}
		return unwrapResult(result);
	} catch {
		return apiError("SITE_CONTENT_ACTION_ERROR", "Failed to update site content", 500);
	}
};
