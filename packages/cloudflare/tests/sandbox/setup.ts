import { vi } from "vitest";

import { testState } from "./helpers.js";

/**
 * Every sandbox test gets a mockable `withBridgeDb` so bridge method tests
 * don't depend on the EmDash Astro integration's virtual modules.
 */
vi.mock("../../src/sandbox/bridge-db.js", () => ({
	withBridgeDb: async <T>(
		_options: unknown,
		fn: (db: import("kysely").Kysely<import("emdash").Database>) => Promise<T>,
	): Promise<T> => {
		if (!testState.currentDb) {
			throw new Error("testState.currentDb is not set");
		}
		return fn(testState.currentDb);
	},
}));
