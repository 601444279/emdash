import { describe, expect, it } from "vitest";

import { SiteRepository } from "../../../src/database/repositories/site.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("SiteRepository", () => {
	it("creates a site with an isolated domain and theme configuration", async () => {
		const db = await setupTestDatabase();
		try {
			const sites = new SiteRepository(db);
			const site = await sites.create({
				key: "vpsvpshosting",
				name: "VPS VPS Hosting",
				domains: ["vpsvpshosting.com"],
				theme: { id: "editorial", version: "1.0.0", settings: { palette: "ocean" } },
			});

			expect(site.key).toBe("vpsvpshosting");
			expect(site.domains).toEqual(["vpsvpshosting.com"]);
			expect(site.theme).toEqual({
				id: "editorial",
				version: "1.0.0",
				settings: {
					palette: "ocean",
					font: "sans",
					cardStyle: "elevated",
					navigation: "inline",
					footer: "columns",
				},
			});
			expect(await sites.findByDomain("vpsvpshosting.com")).toEqual(site);
		} finally {
			await teardownTestDatabase(db);
		}
	});

	it("rejects a domain that is already assigned to another site", async () => {
		const db = await setupTestDatabase();
		try {
			const sites = new SiteRepository(db);
			await sites.create({
				key: "first",
				name: "First",
				domains: ["shared.example.com"],
				theme: { id: "editorial", version: "1.0.0", settings: {} },
			});

			await expect(
				sites.create({
					key: "second",
					name: "Second",
					domains: ["shared.example.com"],
					theme: { id: "catalog", version: "1.0.0", settings: {} },
				}),
			).rejects.toThrow("SITE_DOMAIN_CONFLICT");
		} finally {
			await teardownTestDatabase(db);
		}
	});

	it("moves a domain between updates without leaving the old mapping behind", async () => {
		const db = await setupTestDatabase();
		try {
			const sites = new SiteRepository(db);
			const site = await sites.create({
				key: "first",
				name: "First",
				domains: ["first.example.com"],
				theme: { id: "editorial", version: "1.0.0", settings: {} },
			});

			const updated = await sites.update(site.id, { domains: ["renamed.example.com"] });
			expect(updated?.domains).toEqual(["renamed.example.com"]);
			expect(await sites.findByDomain("first.example.com")).toBeNull();
		} finally {
			await teardownTestDatabase(db);
		}
	});

	it("does not persist unregistered theme settings", async () => {
		const db = await setupTestDatabase();
		try {
			const sites = new SiteRepository(db);
			await expect(
				sites.create({
					key: "unsafe",
					name: "Unsafe",
					domains: [],
					theme: { id: "editorial", version: "1.0.0", settings: { customCss: "body {}" } },
				}),
			).rejects.toThrow("INVALID_THEME_SETTINGS");
		} finally {
			await teardownTestDatabase(db);
		}
	});

	it("records the previous theme and can restore it", async () => {
		const db = await setupTestDatabase();
		try {
			const sites = new SiteRepository(db);
			const site = await sites.create({
				key: "themed",
				name: "Themed",
				domains: [],
				theme: { id: "editorial", version: "1.0.0", settings: { palette: "ocean" } },
			});
			const updated = await sites.update(site.id, {
				theme: { id: "catalog", version: "1.1.0", settings: { palette: "indigo" } },
			});
			expect(updated?.theme.id).toBe("catalog");

			const [previous] = await sites.listThemeHistory(site.id);
			expect(previous?.theme).toEqual({
				id: "editorial",
				version: "1.0.0",
				settings: {
					palette: "ocean",
					font: "sans",
					cardStyle: "elevated",
					navigation: "inline",
					footer: "columns",
				},
			});
			const restored = await sites.rollbackTheme(site.id, previous?.id ?? "");
			expect(restored?.theme).toEqual(previous?.theme);
		} finally {
			await teardownTestDatabase(db);
		}
	});
});
