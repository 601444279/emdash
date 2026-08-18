import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../src/sandbox/bridge-db.js");

// @ts-ignore -- generated virtual module
vi.mock("virtual:emdash/config", () => ({
	default: {
		database: {
			entrypoint: "@emdash-cms/cloudflare/db/hyperdrive",
			config: { binding: "HYPERDRIVE" },
			type: "postgres",
		},
	},
}));

// @ts-ignore -- generated virtual module
vi.mock("virtual:emdash/dialect", () => ({
	createRequestScopedDb: vi.fn(),
	createDialect: vi.fn(),
}));

import type { Database } from "emdash";
import type { Kysely } from "kysely";
// @ts-ignore -- generated virtual module
import * as dialect from "virtual:emdash/dialect";

import { withBridgeDb } from "../../src/sandbox/bridge-db.js";

describe("bridge-db", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("opens an event-scoped connection when the adapter provides one", async () => {
		const fakeDb = { destroy: vi.fn() } as unknown as Kysely<Database>;
		const commit = vi.fn();
		const close = vi.fn();

		// eslint-disable-next-line typescript-eslint/no-unsafe-member-access -- mocked adapter factory
		vi.mocked(dialect.createRequestScopedDb).mockReturnValue({
			db: fakeDb as never,
			commit,
			close,
			// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- adapter opts are opaque to the bridge
		} as never);

		const fn = vi.fn(async () => "result");
		const result = await withBridgeDb({ isWrite: true }, fn);

		expect(result).toBe("result");
		expect(fn).toHaveBeenCalledWith(fakeDb);
		// eslint-disable-next-line typescript-eslint/no-unsafe-member-access -- mocked adapter factory
		expect(dialect.createRequestScopedDb).toHaveBeenCalledWith(
			expect.objectContaining({
				config: { binding: "HYPERDRIVE" },
				isWrite: true,
			}),
		);
		expect(commit).toHaveBeenCalled();
		expect(close).toHaveBeenCalled();
	});
});
