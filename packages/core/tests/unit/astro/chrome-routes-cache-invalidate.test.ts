/**
 * Chrome subsystem write routes must invalidate edge cache tags when they
 * mutate settings, menus, taxonomies, or widget areas.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as menuHandlers from "#api/handlers/menus.js";
import * as settingsHandlers from "#api/handlers/settings.js";
import * as taxonomyHandlers from "#api/handlers/taxonomies.js";

import { POST as settingsUpdateRoute } from "../../../src/astro/routes/api/settings.js";
import { POST as menuCreateRoute } from "../../../src/astro/routes/api/menus/index.js";
import { POST as menuItemCreateRoute } from "../../../src/astro/routes/api/menus/[name]/items.js";
import { POST as menuReorderRoute } from "../../../src/astro/routes/api/menus/[name]/reorder.js";
import { POST as menuTranslationCreateRoute } from "../../../src/astro/routes/api/menus/[name]/translations.js";
import {
	DELETE as menuDeleteRoute,
	PUT as menuUpdateRoute,
} from "../../../src/astro/routes/api/menus/[name].js";
import { POST as taxonomyCreateRoute } from "../../../src/astro/routes/api/taxonomies/index.js";
import { POST as termCreateRoute } from "../../../src/astro/routes/api/taxonomies/[name]/terms/index.js";
import {
	DELETE as termDeleteRoute,
	PUT as termUpdateRoute,
} from "../../../src/astro/routes/api/taxonomies/[name]/terms/[slug].js";
import { POST as termReorderRoute } from "../../../src/astro/routes/api/taxonomies/[name]/reorder.js";
import {
	DELETE as taxonomyDeleteRoute,
	PUT as taxonomyUpdateRoute,
} from "../../../src/astro/routes/api/taxonomies/[name].js";
import { POST as widgetAreaCreateRoute } from "../../../src/astro/routes/api/widget-areas/index.js";
import { DELETE as widgetAreaDeleteRoute } from "../../../src/astro/routes/api/widget-areas/[name].js";
import { POST as widgetReorderRoute } from "../../../src/astro/routes/api/widget-areas/[name]/reorder.js";
import { POST as widgetCreateRoute } from "../../../src/astro/routes/api/widget-areas/[name]/widgets.js";
import {
	DELETE as widgetDeleteRoute,
	PUT as widgetUpdateRoute,
} from "../../../src/astro/routes/api/widget-areas/[name]/widgets/[id].js";
import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";

vi.mock("#api/handlers/settings.js", () => ({
	handleSettingsGet: vi.fn(),
	handleSettingsUpdate: vi.fn(),
}));

vi.mock("#api/handlers/menus.js", () => ({
	handleMenuCreate: vi.fn(),
	handleMenuDelete: vi.fn(),
	handleMenuGet: vi.fn(),
	handleMenuItemCreate: vi.fn(),
	handleMenuItemReorder: vi.fn(),
	handleMenuTranslations: vi.fn(),
	handleMenuUpdate: vi.fn(),
}));

vi.mock("#api/handlers/taxonomies.js", () => ({
	handleTaxonomyCreate: vi.fn(),
	handleTaxonomyDelete: vi.fn(),
	handleTaxonomyGet: vi.fn(),
	handleTaxonomyUpdate: vi.fn(),
	handleTaxonomyDefTranslations: vi.fn(),
	handleTermCreate: vi.fn(),
	handleTermDelete: vi.fn(),
	handleTermGet: vi.fn(),
	handleTermList: vi.fn(),
	handleTermReorder: vi.fn(),
	handleTermUpdate: vi.fn(),
}));

vi.mock("#widgets/index.js", () => ({
	rowToWidget: vi.fn((row: { id: string }) => row),
}));

vi.mock("ulid", () => ({ ulid: vi.fn(() => "w1") }));

const user = { id: "user-1", role: Role.ADMIN };

function makeCache() {
	return { enabled: true as const, invalidate: vi.fn().mockResolvedValue(undefined) };
}

function makeRequest(method: string, url: string, body?: Record<string, unknown>): Request {
	return new Request(url, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("chrome write routes — edge cache invalidation", () => {
	describe("settings", () => {
		it("POST /settings invalidates emdash:settings on success", async () => {
			const cache = makeCache();
			vi.mocked(settingsHandlers.handleSettingsUpdate).mockResolvedValue({
				success: true as const,
				data: { title: "Updated" },
			});

			const request = makeRequest("POST", "http://localhost/_emdash/api/settings", {
				title: "Updated",
			});
			const response = await settingsUpdateRoute({
				request,
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof settingsUpdateRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledTimes(1);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:settings"] });
		});

		it("does not invalidate on failed settings update", async () => {
			const cache = makeCache();
			vi.mocked(settingsHandlers.handleSettingsUpdate).mockResolvedValue({
				success: false as const,
				error: { code: "VALIDATION_ERROR", message: "bad" },
			});

			const request = makeRequest("POST", "http://localhost/_emdash/api/settings", {});
			const response = await settingsUpdateRoute({
				request,
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof settingsUpdateRoute>[0]);

			expect(response.status).toBe(400);
			expect(cache.invalidate).not.toHaveBeenCalled();
		});
	});

	describe("menus", () => {
		it("POST /menus invalidates the created menu tag", async () => {
			const cache = makeCache();
			vi.mocked(menuHandlers.handleMenuCreate).mockResolvedValue({
				success: true as const,
				data: { id: "m1", name: "primary", label: "Primary" },
			});

			const request = makeRequest("POST", "http://localhost/_emdash/api/menus", {
				name: "primary",
				label: "Primary",
			});
			const response = await menuCreateRoute({
				request,
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof menuCreateRoute>[0]);

			expect(response.status).toBe(201);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("PUT /menus/:name invalidates the menu tag", async () => {
			const cache = makeCache();
			vi.mocked(menuHandlers.handleMenuUpdate).mockResolvedValue({
				success: true as const,
				data: { id: "m1", name: "primary", label: "Primary Nav" },
			});

			const request = makeRequest("PUT", "http://localhost/_emdash/api/menus/primary", {
				label: "Primary Nav",
			});
			const response = await menuUpdateRoute({
				params: { name: "primary" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof menuUpdateRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("DELETE /menus/:name invalidates the menu tag", async () => {
			const cache = makeCache();
			vi.mocked(menuHandlers.handleMenuDelete).mockResolvedValue({
				success: true as const,
				data: { deleted: true },
			});

			const request = makeRequest("DELETE", "http://localhost/_emdash/api/menus/primary");
			const response = await menuDeleteRoute({
				params: { name: "primary" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof menuDeleteRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("POST /menus/:name/items invalidates the menu tag", async () => {
			const cache = makeCache();
			vi.mocked(menuHandlers.handleMenuItemCreate).mockResolvedValue({
				success: true as const,
				data: { id: "mi1", label: "Home" },
			});

			const request = makeRequest("POST", "http://localhost/_emdash/api/menus/primary/items", {
				label: "Home",
				type: "custom",
				customUrl: "/",
			});
			const response = await menuItemCreateRoute({
				params: { name: "primary" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof menuItemCreateRoute>[0]);

			expect(response.status).toBe(201);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("POST /menus/:name/reorder invalidates the menu tag", async () => {
			const cache = makeCache();
			vi.mocked(menuHandlers.handleMenuItemReorder).mockResolvedValue({
				success: true as const,
				data: { reordered: true },
			});

			const request = makeRequest("POST", "http://localhost/_emdash/api/menus/primary/reorder", {
				items: [
					{ id: "mi1", parentId: null, sortOrder: 0 },
					{ id: "mi2", parentId: null, sortOrder: 1 },
				],
			});
			const response = await menuReorderRoute({
				params: { name: "primary" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof menuReorderRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});

		it("POST /menus/:name/translations invalidates the menu tag", async () => {
			const cache = makeCache();
			vi.mocked(menuHandlers.handleMenuCreate).mockResolvedValue({
				success: true as const,
				data: { id: "m2", name: "primary", label: "Primario", locale: "es" },
			});
			vi.mocked(menuHandlers.handleMenuGet).mockResolvedValue({
				success: true as const,
				data: { id: "m1", name: "primary", label: "Primary", locale: "en" },
			});

			const request = makeRequest(
				"POST",
				"http://localhost/_emdash/api/menus/primary/translations",
				{ locale: "es", label: "Primario" },
			);
			const response = await menuTranslationCreateRoute({
				params: { name: "primary" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof menuTranslationCreateRoute>[0]);

			expect(response.status).toBe(201);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:menu:primary"] });
		});
	});

	describe("taxonomies", () => {
		it("POST /taxonomies invalidates the created taxonomy tag", async () => {
			const cache = makeCache();
			vi.mocked(taxonomyHandlers.handleTaxonomyCreate).mockResolvedValue({
				success: true as const,
				data: { taxonomy: { id: "t1", name: "category", label: "Category" } },
			});

			const request = makeRequest("POST", "http://localhost/_emdash/api/taxonomies", {
				name: "category",
				label: "Category",
			});
			const response = await taxonomyCreateRoute({
				request,
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof taxonomyCreateRoute>[0]);

			expect(response.status).toBe(201);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:category"] });
		});

		it("PUT /taxonomies/:name invalidates the taxonomy tag", async () => {
			const cache = makeCache();
			vi.mocked(taxonomyHandlers.handleTaxonomyUpdate).mockResolvedValue({
				success: true as const,
				data: { taxonomy: { id: "t1", name: "category", label: "Categories" } },
			});

			const request = makeRequest("PUT", "http://localhost/_emdash/api/taxonomies/category", {
				label: "Categories",
			});
			const response = await taxonomyUpdateRoute({
				params: { name: "category" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof taxonomyUpdateRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:category"] });
		});

		it("DELETE /taxonomies/:name invalidates the taxonomy tag", async () => {
			const cache = makeCache();
			vi.mocked(taxonomyHandlers.handleTaxonomyDelete).mockResolvedValue({
				success: true as const,
				data: { deleted: true },
			});

			const request = makeRequest("DELETE", "http://localhost/_emdash/api/taxonomies/category");
			const response = await taxonomyDeleteRoute({
				params: { name: "category" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof taxonomyDeleteRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:category"] });
		});

		it("POST /taxonomies/:name/reorder invalidates the taxonomy tag", async () => {
			const cache = makeCache();
			vi.mocked(taxonomyHandlers.handleTermReorder).mockResolvedValue({
				success: true as const,
				data: { reordered: true },
			});

			const request = makeRequest(
				"POST",
				"http://localhost/_emdash/api/taxonomies/category/reorder",
				{ ids: ["t1", "t2"] },
			);
			const response = await termReorderRoute({
				params: { name: "category" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof termReorderRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:category"] });
		});

		it("POST /taxonomies/:name/terms invalidates the taxonomy tag", async () => {
			const cache = makeCache();
			vi.mocked(taxonomyHandlers.handleTermCreate).mockResolvedValue({
				success: true as const,
				data: { term: { id: "t1", name: "category", slug: "news", label: "News" } },
			});

			const request = makeRequest("POST", "http://localhost/_emdash/api/taxonomies/category/terms", {
				label: "News",
				slug: "news",
			});
			const response = await termCreateRoute({
				params: { name: "category" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof termCreateRoute>[0]);

			expect(response.status).toBe(201);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:category"] });
		});

		it("PUT /taxonomies/:name/terms/:slug invalidates the taxonomy tag", async () => {
			const cache = makeCache();
			vi.mocked(taxonomyHandlers.handleTermUpdate).mockResolvedValue({
				success: true as const,
				data: { term: { id: "t1", name: "category", slug: "news", label: "Breaking News" } },
			});

			const request = makeRequest(
				"PUT",
				"http://localhost/_emdash/api/taxonomies/category/terms/news",
				{ label: "Breaking News" },
			);
			const response = await termUpdateRoute({
				params: { name: "category", slug: "news" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof termUpdateRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:category"] });
		});

		it("DELETE /taxonomies/:name/terms/:slug invalidates the taxonomy tag", async () => {
			const cache = makeCache();
			vi.mocked(taxonomyHandlers.handleTermDelete).mockResolvedValue({
				success: true as const,
				data: { deleted: true },
			});

			const request = makeRequest(
				"DELETE",
				"http://localhost/_emdash/api/taxonomies/category/terms/news",
			);
			const response = await termDeleteRoute({
				params: { name: "category", slug: "news" },
				request,
				url: new URL(request.url),
				locals: { emdash: { db: {} }, user },
				cache,
			} as Parameters<typeof termDeleteRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:taxonomy:category"] });
		});
	});

	describe("widget areas", () => {
		let db: Kysely<Database>;

		beforeEach(async () => {
			db = createDatabase({ url: ":memory:" });
			await runMigrations(db);
		});

		async function createArea(name: string) {
			const id = ulid();
			await db
				.insertInto("_emdash_widget_areas")
				.values({ id, name, label: name, description: null })
				.execute();
			return id;
		}

		async function createWidget(areaId: string, title: string) {
			const id = ulid();
			await db
				.insertInto("_emdash_widgets")
				.values({
					id,
					area_id: areaId,
					sort_order: 0,
					type: "content",
					title,
					content: null,
					menu_name: null,
					component_id: null,
					component_props: null,
				})
				.execute();
			return id;
		}

		it("POST /widget-areas invalidates the created area tag", async () => {
			const cache = makeCache();

			const request = makeRequest("POST", "http://localhost/_emdash/api/widget-areas", {
				name: "sidebar",
				label: "Sidebar",
			});
			const response = await widgetAreaCreateRoute({
				request,
				locals: { emdash: { db }, user },
				cache,
			} as Parameters<typeof widgetAreaCreateRoute>[0]);

			expect(response.status).toBe(201);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});

		it("DELETE /widget-areas/:name invalidates the area tag", async () => {
			const cache = makeCache();
			await createArea("sidebar");

			const request = makeRequest("DELETE", "http://localhost/_emdash/api/widget-areas/sidebar");
			const response = await widgetAreaDeleteRoute({
				params: { name: "sidebar" },
				request,
				locals: { emdash: { db }, user },
				cache,
			} as Parameters<typeof widgetAreaDeleteRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});

		it("POST /widget-areas/:name/reorder invalidates the area tag", async () => {
			const cache = makeCache();
			const areaId = await createArea("sidebar");
			const widgetId = await createWidget(areaId, "Widget");

			const request = makeRequest(
				"POST",
				"http://localhost/_emdash/api/widget-areas/sidebar/reorder",
				{ widgetIds: [widgetId] },
			);
			const response = await widgetReorderRoute({
				params: { name: "sidebar" },
				request,
				locals: { emdash: { db }, user },
				cache,
			} as Parameters<typeof widgetReorderRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});

		it("POST /widget-areas/:name/widgets invalidates the area tag", async () => {
			const cache = makeCache();
			await createArea("sidebar");

			const request = makeRequest(
				"POST",
				"http://localhost/_emdash/api/widget-areas/sidebar/widgets",
				{ type: "content", title: "New Widget" },
			);
			const response = await widgetCreateRoute({
				params: { name: "sidebar" },
				request,
				locals: { emdash: { db }, user },
				cache,
			} as Parameters<typeof widgetCreateRoute>[0]);

			expect(response.status).toBe(201);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});

		it("PUT /widget-areas/:name/widgets/:id invalidates the area tag", async () => {
			const cache = makeCache();
			const areaId = await createArea("sidebar");
			const widgetId = await createWidget(areaId, "Widget");

			const request = makeRequest(
				"PUT",
				`http://localhost/_emdash/api/widget-areas/sidebar/widgets/${widgetId}`,
				{ title: "Updated" },
			);
			const response = await widgetUpdateRoute({
				params: { name: "sidebar", id: widgetId },
				request,
				locals: { emdash: { db }, user },
				cache,
			} as Parameters<typeof widgetUpdateRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});

		it("DELETE /widget-areas/:name/widgets/:id invalidates the area tag", async () => {
			const cache = makeCache();
			const areaId = await createArea("sidebar");
			const widgetId = await createWidget(areaId, "Widget");

			const request = makeRequest(
				"DELETE",
				`http://localhost/_emdash/api/widget-areas/sidebar/widgets/${widgetId}`,
			);
			const response = await widgetDeleteRoute({
				params: { name: "sidebar", id: widgetId },
				request,
				locals: { emdash: { db }, user },
				cache,
			} as Parameters<typeof widgetDeleteRoute>[0]);

			expect(response.status).toBe(200);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["emdash:widget-area:sidebar"] });
		});
	});
});
