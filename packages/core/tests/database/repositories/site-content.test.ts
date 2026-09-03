import { describe, expect, it } from "vitest";

import { SiteContentRepository } from "../../../src/database/repositories/site-content.js";
import { SiteRepository } from "../../../src/database/repositories/site.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("SiteContentRepository", () => {
	it("does not resolve content from a different site", async () => {
		const db = await setupTestDatabaseWithCollections();
		try {
			const sites = new SiteRepository(db);
			const first = await sites.create({
				key: "first",
				name: "First",
				domains: [],
				theme: { id: "editorial", version: "1.0.0", settings: {} },
			});
			const second = await sites.create({
				key: "second",
				name: "Second",
				domains: [],
				theme: { id: "catalog", version: "1.0.0", settings: {} },
			});
			const content = new SiteContentRepository(db);
			const item = await content.create(first.id, {
				type: "post",
				slug: "only-first",
				data: { title: "Only first" },
			});

			expect(await content.findById(first.id, "post", item.id)).toMatchObject({ id: item.id });
			expect(await content.findById(second.id, "post", item.id)).toBeNull();
			await content.create(first.id, {
				type: "post",
				slug: "published-only-first",
				status: "published",
				data: { title: "Published only first" },
			});
			expect((await content.listPublished(first.id, "post")).map((entry) => entry.slug)).toEqual([
				"published-only-first",
			]);
			expect((await content.list(first.id, "post")).map((entry) => entry.slug).toSorted()).toEqual([
				"only-first",
				"published-only-first",
			]);
			expect(await content.listPublished(second.id, "post")).toEqual([]);
			expect(await content.list(second.id, "post")).toEqual([]);
			expect(await content.findBySlug(second.id, "post", "published-only-first")).toBeNull();
		} finally {
			await teardownTestDatabase(db);
		}
	});

	it("lists taxonomy content only from the requested site", async () => {
		const db = await setupTestDatabaseWithCollections();
		try {
			const sites = new SiteRepository(db);
			const first = await sites.create({ key: "first", name: "First", domains: [], theme: { id: "editorial", version: "1.0.0", settings: {} } });
			const second = await sites.create({ key: "second", name: "Second", domains: [], theme: { id: "catalog", version: "1.0.0", settings: {} } });
			const content = new SiteContentRepository(db);
			const taxonomy = await new TaxonomyRepository(db).create({ name: "category", slug: "guides", label: "Guides" });
			const firstPost = await content.create(first.id, { type: "post", slug: "first-guide", status: "published", data: { title: "First" } });
			const secondPost = await content.create(second.id, { type: "post", slug: "second-guide", status: "published", data: { title: "Second" } });
			const terms = new TaxonomyRepository(db);
			await terms.setTermsForEntry("post", firstPost.id, "category", [taxonomy.id]);
			await terms.setTermsForEntry("post", secondPost.id, "category", [taxonomy.id]);

			expect((await content.listPublishedByTaxonomy(first.id, "post", "category", "guides")).map((item) => item.slug)).toEqual(["first-guide"]);
			expect((await content.listPublishedByTaxonomy(second.id, "post", "category", "guides")).map((item) => item.slug)).toEqual(["second-guide"]);
		} finally {
			await teardownTestDatabase(db);
		}
	});
});
