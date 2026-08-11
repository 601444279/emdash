import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { executeCollectionDeletionGuard } from "../../../cloudflare/src/db/d1.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
});

afterAll(async () => {
	await db.destroy();
});

it("rolls back a stale guarded batch before any collection DDL", async () => {
	await sql`CREATE TABLE ec_d1_guarded (id TEXT PRIMARY KEY)`.execute(db);
	await db
		.insertInto("_emdash_media_usage_collection_deletions")
		.values({
			collection_id: "collection-d1",
			collection_slug: "d1_guarded",
			force_delete: 1,
			state: "leased",
			phase: "table",
			next_attempt_at: "2000-01-01T00:00:00.000Z",
			lease_token: "current-owner",
			lease_expires_at: "2999-01-01T00:00:00.000Z",
		})
		.execute();

	await expect(
		executeCollectionDeletionGuard(
			{ binding: "DB" },
			{
				action: "drop",
				collectionId: "collection-d1",
				collectionSlug: "d1_guarded",
				leaseToken: "stale-owner",
			},
		),
	).resolves.toEqual({ outcome: "stale" });

	const table = await sql<{ name: string }>`
		SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ec_d1_guarded'
	`.execute(db);
	expect(table.rows).toEqual([{ name: "ec_d1_guarded" }]);
	expect(
		await db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.select("collection_id")
			.execute(),
	).toEqual([{ collection_id: "collection-d1" }]);

	await expect(
		executeCollectionDeletionGuard(
			{ binding: "DB" },
			{
				action: "drop",
				collectionId: "collection-d1",
				collectionSlug: "d1_guarded",
				leaseToken: "current-owner",
			},
		),
	).resolves.toEqual({ outcome: "dropped" });
	const dropped = await sql<{ name: string }>`
		SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ec_d1_guarded'
	`.execute(db);
	expect(dropped.rows).toEqual([]);
	expect(
		await db
			.selectFrom("_emdash_media_usage_collection_deletions")
			.select("collection_id")
			.execute(),
	).toEqual([{ collection_id: "collection-d1" }]);
});
