import type { Database } from "emdash";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

/**
 * Per-test override for the database that bridge-db.ts resolves.
 * Tests set this before calling PluginBridge methods.
 */
export const testState: { currentDb: Kysely<Database> | null } = { currentDb: null };

/**
 * Wrap a fake D1Database interface in a Kysely instance using the same D1
 * dialect the sandbox bridge uses in production. This lets existing tests
 * keep recording SQL and parameters via a fake D1 while the bridge routes
 * through Kysely and core repositories.
 */
export function createTestDb(fakeD1: unknown): Kysely<Database> {
	return new Kysely<Database>({
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fake D1 is a test stand-in
		dialect: new D1Dialect({ database: fakeD1 as never }),
	});
}
