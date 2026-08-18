/**
 * Tests for the PluginBridge taxonomy methods (taxonomyList, taxonomyTerms,
 * taxonomyEntryTerms): capability enforcement, SQL/parameter wiring for the
 * locale/taxonomy filters, and D1 row mapping (JSON parsing, int→bool,
 * nullable columns).
 */

import { describe, expect, it, vi } from "vitest";

// PluginBridge extends WorkerEntrypoint from cloudflare:workers, which is
// not importable under plain vitest. Substitute a minimal base class that
// stores ctx/env the way the runtime does.
vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

import { PluginBridge } from "../../src/sandbox/bridge.js";
import { createTestDb, testState } from "./helpers.js";

type Row = Record<string, unknown>;

interface RecordedQuery {
	sql: string;
	params: unknown[];
}

/** Minimal fake D1Database: records SQL + bound params, returns canned rows. */
function fakeD1(rows: Row[], recorded: RecordedQuery[]) {
	return {
		prepare(sql: string) {
			const statement = {
				params: [] as unknown[],
				bind(...args: unknown[]) {
					statement.params = args;
					return statement;
				},
				async all() {
					recorded.push({ sql, params: statement.params });
					return { results: rows, meta: { changes: 0 } };
				},
			};
			return statement;
		},
	};
}

function makeBridge(capabilities: string[], rows: Row[] = []) {
	const recorded: RecordedQuery[] = [];
	const ctx = {
		props: {
			pluginId: "test-plugin",
			pluginVersion: "1.0.0",
			capabilities,
			allowedHosts: [],
			storageCollections: [],
		},
	};
	testState.currentDb = createTestDb(fakeD1(rows, recorded));
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- fake ctx/env stand in for the Workers runtime injections
	const bridge = new PluginBridge(ctx as never, {} as never);
	return { bridge, recorded };
}

const TERM_ROW: Row = {
	id: "term-1",
	name: "category",
	slug: "news",
	label: "News",
	parent_id: null,
	data: '{"color":"red"}',
	locale: "en",
	translation_group: "tg-1",
	// Ensure stable tiebreaker against the unordered term row used in join tests.
	sort_order: 0,
};

describe("PluginBridge taxonomy methods — capability enforcement", () => {
	it("rejects all three methods without taxonomies:read", async () => {
		// content:read must not grant taxonomy access.
		const { bridge } = makeBridge(["content:read"]);
		await expect(bridge.taxonomyList()).rejects.toThrow(/taxonomies:read/);
		await expect(bridge.taxonomyTerms("category")).rejects.toThrow(/taxonomies:read/);
		await expect(bridge.taxonomyEntryTerms("posts", "p1")).rejects.toThrow(/taxonomies:read/);
	});
});

describe("taxonomyList", () => {
	it("maps rows: int→bool, JSON collections, nullable label_singular", async () => {
		const { bridge } = makeBridge(
			["taxonomies:read"],
			[
				{
					name: "category",
					label: "Categories",
					label_singular: "Category",
					hierarchical: 1,
					collections: '["posts","pages"]',
					locale: "en",
				},
				{
					name: "tag",
					label: "Tags",
					label_singular: null,
					hierarchical: 0,
					collections: "not-json",
					locale: "en",
				},
			],
		);

		const defs = await bridge.taxonomyList();
		expect(defs).toEqual([
			{
				name: "category",
				label: "Categories",
				labelSingular: "Category",
				hierarchical: true,
				collections: ["posts", "pages"],
				locale: "en",
			},
			{
				name: "tag",
				label: "Tags",
				labelSingular: null,
				hierarchical: false,
				collections: [],
				locale: "en",
			},
		]);
	});

	it("filters by locale only when provided", async () => {
		const { bridge, recorded } = makeBridge(["taxonomies:read"]);
		await bridge.taxonomyList();
		await bridge.taxonomyList({ locale: "de" });

		expect(recorded[0]?.sql).not.toContain("locale");
		expect(recorded[0]?.params).toEqual([]);
		expect(recorded[1]?.sql).toMatch(/where\s+["']?locale["']?\s*=\s*\?/i);
		expect(recorded[1]?.params).toEqual(["de"]);
	});
});

describe("taxonomyTerms", () => {
	it("maps rows including JSON data and translation group", async () => {
		const { bridge } = makeBridge(["taxonomies:read"], [TERM_ROW]);
		const terms = await bridge.taxonomyTerms("category");
		expect(terms).toEqual([
			{
				id: "term-1",
				taxonomy: "category",
				slug: "news",
				label: "News",
				parentId: null,
				data: { color: "red" },
				locale: "en",
				translationGroup: "tg-1",
			},
		]);
	});

	it("returns null data for malformed JSON", async () => {
		const { bridge } = makeBridge(["taxonomies:read"], [{ ...TERM_ROW, data: "{broken" }]);
		const terms = await bridge.taxonomyTerms("category");
		expect(terms[0]?.data).toBeNull();
	});

	it("binds the taxonomy name and appends the locale filter when provided", async () => {
		const { bridge, recorded } = makeBridge(["taxonomies:read"]);
		await bridge.taxonomyTerms("category");
		await bridge.taxonomyTerms("category", { locale: "fr" });

		expect(recorded[0]?.sql).toMatch(/where\s+["']?name["']?\s*=\s*\?/i);
		expect(recorded[0]?.params).toEqual(["category"]);
		expect(recorded[1]?.sql).toMatch(/["']?locale["']?\s*=\s*\?/i);
		expect(recorded[1]?.params).toEqual(["category", "fr"]);
	});

	// Terms carry a manual order, so a plugin reading through the bridge has to
	// get the same order core's TaxonomyRepository.findByName returns. The clause
	// is built through Kysely here, so assert the ordering is preserved.
	it("orders by the manual position ahead of the label", async () => {
		const { bridge, recorded } = makeBridge(["taxonomies:read"]);
		await bridge.taxonomyTerms("category");

		expect(recorded[0]?.sql).toMatch(
			/order by\s+["']?sort_order["']?\s+asc,?\s+["']?label["']?\s+asc,?\s+["']?id["']?\s+asc/i,
		);
	});
});

describe("taxonomyEntryTerms", () => {
	it("joins the pivot on translation_group and binds collection + entry", async () => {
		const { bridge, recorded } = makeBridge(["taxonomies:read"], [TERM_ROW]);
		const terms = await bridge.taxonomyEntryTerms("posts", "post-1");

		expect(recorded[0]?.sql).toMatch(
			/join\s+["']?taxonomies["']?\s+on\s+["']?taxonomies["']?\.["']?translation_group["']?\s*=\s*["']?content_taxonomies["']?\.["']?taxonomy_id["']?/i,
		);
		expect(recorded[0]?.params).toEqual(["posts", "post-1"]);
		expect(terms[0]?.taxonomy).toBe("category");
	});

	it("appends taxonomy and locale filters in order when provided", async () => {
		const { bridge, recorded } = makeBridge(["taxonomies:read"]);
		await bridge.taxonomyEntryTerms("posts", "post-1", { taxonomy: "tag", locale: "de" });

		expect(recorded[0]?.sql).toMatch(/["']?taxonomies["']?\.["']?name["']?\s*=\s*\?/i);
		expect(recorded[0]?.sql).toMatch(/["']?taxonomies["']?\.["']?locale["']?\s*=\s*\?/i);
		expect(recorded[0]?.params).toEqual(["posts", "post-1", "tag", "de"]);
	});
});
