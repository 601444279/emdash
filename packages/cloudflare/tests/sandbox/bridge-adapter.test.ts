import { describe, expect, it, vi } from "vitest";

vi.mock("pg", () => ({
	Pool: class FakePool {
		async query(_config: { text: string; values?: unknown[] }) {
			return { rows: [] };
		}
		async connect() {
			return {
				async query(_config: { text: string; values?: unknown[] }) {
					return { rows: [] };
				},
				release() {},
			};
		}
	},
}));

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
	env: { HYPERDRIVE: { connectionString: "postgres://localhost:5432/emdash" } },
	waitUntil: vi.fn(),
}));

import { PluginBridge } from "../../src/sandbox/bridge.js";

function makeBridge(descriptor?: { entrypoint: string; type: "sqlite" | "postgres" }) {
	const ctx = {
		props: {
			pluginId: "test-plugin",
			pluginVersion: "1.0.0",
			capabilities: [
				"content:read",
				"content:write",
				"taxonomies:read",
				"media:read",
				"media:write",
				"users:read",
			],
			allowedHosts: [],
			storageCollections: ["items"],
			storageConfig: { items: { indexes: ["kind"] } },
			databaseDescriptor: descriptor
				? {
						entrypoint: descriptor.entrypoint,
						config: { binding: "HYPERDRIVE" },
						type: descriptor.type,
					}
				: undefined,
		},
	};
	const env = {
		DB: {} as never,
		HYPERDRIVE: { connectionString: "postgres://localhost:5432/emdash" },
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- fake ctx/env stand in for the Workers runtime injections
	return new PluginBridge(ctx as never, env as never);
}

describe("PluginBridge adapter-aware database resolution", () => {
	it("routes reads through a Hyperdrive descriptor without touching a D1 binding", async () => {
		const bridge = makeBridge({
			entrypoint: "@emdash-cms/cloudflare/db/hyperdrive",
			type: "postgres",
		});

		await expect(bridge.kvGet("test")).resolves.toBeNull();
		await expect(bridge.storageGet("items", "1")).resolves.toBeNull();
		await expect(bridge.storageQuery("items", { limit: 10 })).resolves.toEqual({
			items: [],
			hasMore: false,
		});
		await expect(bridge.contentGet("posts", "1")).resolves.toBeNull();
		await expect(bridge.contentList("posts")).resolves.toEqual({ items: [], hasMore: false });
		await expect(bridge.taxonomyList()).resolves.toEqual([]);
		await expect(bridge.taxonomyTerms("tags")).resolves.toEqual([]);
		await expect(bridge.taxonomyEntryTerms("posts", "1")).resolves.toEqual([]);
		await expect(bridge.mediaGet("1")).resolves.toBeNull();
		await expect(bridge.mediaList({ limit: 10 })).resolves.toEqual({ items: [], hasMore: false });
		await expect(bridge.userGet("1")).resolves.toBeNull();
		await expect(bridge.userGetByEmail("test@example.com")).resolves.toBeNull();
		await expect(bridge.userList({ limit: 10 })).resolves.toEqual({ items: [] });
	});

	it("falls back to env.DB when no databaseDescriptor is provided", async () => {
		const db = {
			prepare(_sql: string) {
				return {
					bind() {
						return this;
					},
					async first() {
						return {
							id: "post-1",
							locale: "en",
							created_at: "2026-08-16T00:00:00.000Z",
							updated_at: "2026-08-16T00:00:00.000Z",
						};
					},
				};
			},
		};
		const ctx = {
			props: {
				pluginId: "test-plugin",
				pluginVersion: "1.0.0",
				capabilities: ["content:read"],
				allowedHosts: [],
				storageCollections: [],
			},
		};
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- fake ctx/env stand in for the Workers runtime injections
		const bridge = new PluginBridge(ctx as never, { DB: db } as never);

		await expect(bridge.contentGet("posts", "post-1")).resolves.toMatchObject({
			id: "post-1",
			locale: "en",
		});
	});
});
