import { describe, expect, it } from "vitest";

import { up } from "../../../src/database/migrations/079_remove_editorial_theme.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("079_remove_editorial_theme", () => {
	it("moves Editorial sites to Ranked and removes their history", async () => {
		const db = await setupTestDatabase();
		try {
			const legacy = await db
				.selectFrom("_emdash_sites")
				.select("id")
				.where("key", "=", "legacy")
				.executeTakeFirstOrThrow();
			await db
				.updateTable("_emdash_sites")
				.set({
					active_theme_id: "editorial",
					active_theme_version: "1.0.0",
					theme_settings: JSON.stringify({ palette: "ocean" }),
				})
				.where("id", "=", legacy.id)
				.execute();
			await db
				.insertInto("_emdash_site_theme_history")
				.values({
					id: "theme-history",
					site_id: legacy.id,
					theme_id: "editorial",
					theme_version: "1.0.0",
					theme_settings: JSON.stringify({ palette: "ocean" }),
				})
				.execute();

			await up(db);

			expect(
				await db
					.selectFrom("_emdash_sites")
					.select(["active_theme_id", "active_theme_version", "theme_settings"])
					.where("id", "=", legacy.id)
					.executeTakeFirstOrThrow(),
			).toEqual({
				active_theme_id: "ranked",
				active_theme_version: "1.0.0",
				theme_settings: JSON.stringify({
					palette: "forest",
					font: "serif",
					cardStyle: "elevated",
					navigation: "inline",
					footer: "columns",
				}),
			});
			expect(
				await db
					.selectFrom("_emdash_site_theme_history")
					.select("id")
					.where("theme_id", "=", "editorial")
					.execute(),
			).toEqual([]);
		} finally {
			await teardownTestDatabase(db);
		}
	});
});
