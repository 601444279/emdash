/**
 * Query-plan shape of the pivot-driven byline listing.
 *
 * A byline-only filter now drives from `_emdash_content_bylines` instead of
 * scanning the whole `ec_*` table and probing a correlated EXISTS per row. On
 * stats-blind SQLite/D1 the new composite index makes the seek unambiguous.
 *
 * This asserts the plan, not the output (output is covered by
 * loader-byline-filter). SQLite-only: `EXPLAIN QUERY PLAN` is a SQLite concern
 * and matches D1 exactly because both are stats-blind here.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { emdashLoader, resetTaxonomyNamesCache } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let captured: CapturedQuery[];

beforeEach(async () => {
	captured = [];
	sqlite = new Database(":memory:");
	db = new Kysely<DatabaseSchema>({
		dialect: new SqliteDialect({ database: sqlite }),
		log(event) {
			if (event.level === "query") {
				captured.push({ sql: event.query.sql, parameters: event.query.parameters });
			}
		},
	});

	await runMigrations(db);
	resetTaxonomyNamesCache();
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema vs Database type
	const anyDb = db as any;
	const content = new ContentRepository(anyDb);
	// A selective byline: one credited entry among many.
	for (let i = 0; i < 30; i++) {
		const post = await content.create({
			type: "post",
			slug: `post-${i}`,
			data: { title: `Post ${i}` },
			status: "published",
			locale: "en",
		});
		if (i === 0) {
			await db
				.insertInto("_emdash_content_bylines" as never)
				.values({
					id: "cb_selective",
					collection_slug: "post",
					content_id: post.id,
					byline_id: "byline_alice",
					sort_order: 0,
				} as never)
				.execute();
		}
	}
});

afterEach(async () => {
	await db.destroy();
});

function bindable(p: unknown): unknown {
	if (typeof p === "boolean") return p ? 1 : 0;
	if (p instanceof Date) return p.toISOString();
	if (p === undefined) return null;
	return p;
}

function explain(query: CapturedQuery): string {
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters.map(bindable)) as { detail: string }[];
	return rows.map((r) => r.detail).join("\n");
}

function pivotQueryPlan(): string {
	const query = captured.find((q) => q.sql.includes("picked"));
	expect(query, "expected the loader to emit a pivot-drive query").toBeDefined();
	return explain(query!);
}

async function runLoad(extra: Record<string, unknown>): Promise<void> {
	captured = [];
	const loader = emdashLoader();
	await runWithContext({ editMode: false, db }, () =>
		loader.loadCollection!({
			filter: { type: "post", where: { byline: "byline_alice" } as never, limit: 5, ...extra },
		}),
	);
}

it("seeks byline credits for the default created_at sort", async () => {
	await runLoad({});
	const plan = pivotQueryPlan();
	expect(plan).toContain("idx_content_bylines_byline_collection");
	expect(plan).not.toContain("SCAN r");
});

it("seeks byline credits for a published_at sort", async () => {
	await runLoad({ orderBy: { published_at: "desc" } });
	const plan = pivotQueryPlan();
	expect(plan).toContain("idx_content_bylines_byline_collection");
	expect(plan).not.toContain("SCAN r");
});
