import { describe, expect, it, vi } from "vitest";

import { GET as getPublishedContentBySlug } from "../../../src/astro/routes/api/public/sites/[key]/content/[collection]/[slug].js";
import { GET as getPublishedContent } from "../../../src/astro/routes/api/public/sites/[key]/content/[collection]/index.js";
import { PUT as updateSiteContent } from "../../../src/astro/routes/api/sites/[key]/content/[collection]/[slug].js";
import { SiteContentRepository } from "../../../src/database/repositories/site-content.js";
import { SiteRepository } from "../../../src/database/repositories/site.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("public site content routes", () => {
	it("only exposes published content belonging to the requested site", async () => {
		const db = await setupTestDatabaseWithCollections();
		try {
			const sites = new SiteRepository(db);
			const first = await sites.create({
				key: "first",
				name: "First",
				domains: [],
				theme: { id: "ranked", version: "1.0.0", settings: {} },
			});
			const second = await sites.create({
				key: "second",
				name: "Second",
				domains: [],
				theme: { id: "catalog", version: "1.0.0", settings: {} },
			});
			const content = new SiteContentRepository(db);
			await content.create(first.id, {
				type: "post",
				slug: "visible-first",
				status: "published",
				data: { title: "Visible first" },
			});
			await content.create(first.id, {
				type: "post",
				slug: "draft-first",
				data: { title: "Draft first" },
			});
			await content.create(second.id, {
				type: "post",
				slug: "visible-second",
				status: "published",
				data: { title: "Visible second" },
			});

			const listResponse = await getPublishedContent({
				locals: { emdash: { db } },
				params: { key: "first", collection: "post" },
				url: new URL("https://cms.example/_emdash/api/public/sites/first/content/post"),
			} as Parameters<typeof getPublishedContent>[0]);
			expect(listResponse.status).toBe(200);
			expect(listResponse.headers.get("Cache-Control")).toContain("public");
			expect(
				(await listResponse.json()).data.items.map((item: { slug: string }) => item.slug),
			).toEqual(["visible-first"]);

			const hiddenResponse = await getPublishedContentBySlug({
				locals: { emdash: { db } },
				params: { key: "second", collection: "post", slug: "visible-first" },
			} as Parameters<typeof getPublishedContentBySlug>[0]);
			expect(hiddenResponse.status).toBe(404);
		} finally {
			await teardownTestDatabase(db);
		}
	});
});

describe("site content write routes", () => {
	it("does not update content assigned to another site", async () => {
		const db = await setupTestDatabaseWithCollections();
		try {
			const sites = new SiteRepository(db);
			const first = await sites.create({
				key: "first",
				name: "First",
				domains: [],
				theme: { id: "ranked", version: "1.0.0", settings: {} },
			});
			await sites.create({
				key: "second",
				name: "Second",
				domains: [],
				theme: { id: "catalog", version: "1.0.0", settings: {} },
			});
			await new SiteContentRepository(db).create(first.id, {
				type: "post",
				slug: "only-first",
				data: { title: "Only first" },
			});
			const handleContentUpdate = vi.fn();

			const response = await updateSiteContent({
				locals: {
					emdash: { db, handleContentUpdate },
					user: { id: "admin", role: 50 },
				},
				params: { key: "second", collection: "post", slug: "only-first" },
				request: new Request(
					"https://cms.example/_emdash/api/sites/second/content/post/only-first",
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ data: { title: "Should not update" } }),
					},
				),
			} as Parameters<typeof updateSiteContent>[0]);

			expect(response.status).toBe(404);
			expect(handleContentUpdate).not.toHaveBeenCalled();
		} finally {
			await teardownTestDatabase(db);
		}
	});
});
