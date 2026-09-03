import { describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { up } from "../../../src/database/migrations/075_site_content.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("075_site_content", () => {
	it("assigns pre-existing content to the legacy site", async () => {
		const db = await setupTestDatabaseWithCollections();
		try {
			const content = new ContentRepository(db);
			const item = await content.create({
				type: "post",
				slug: "before-multisite",
				data: { title: "Before multisite" },
			});

			await up(db);

			const mapping = await db
				.selectFrom("_emdash_site_content")
				.select(["site_id", "collection", "entry_id"])
				.where("entry_id", "=", item.id)
				.executeTakeFirstOrThrow();
			expect(mapping).toEqual({
				site_id: "01J00000000000000000000000",
				collection: "post",
				entry_id: item.id,
			});
		} finally {
			await teardownTestDatabase(db);
		}
	});
});
