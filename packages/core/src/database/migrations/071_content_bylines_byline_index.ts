import type { Kysely } from "kysely";

import { indexExists } from "../dialect-helpers.js";

/**
 * Add a covering index for byline-driven listing queries.
 *
 * On SQLite/D1 the planner needs an unambiguous leading key to seek a
 * selective byline without table statistics. The existing
 * idx_content_bylines_byline (byline_id alone) can be mis-chosen to scan
 * every credit for a collection; leading with byline_id + collection_slug
 * lets the planner seek the byline and probe the exact credits, collapsing
 * the read count from collection-size scale to credit count.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await indexExists(db, "idx_content_bylines_byline_collection"))) {
		await db.schema
			.createIndex("idx_content_bylines_byline_collection")
			.on("_emdash_content_bylines")
			.columns(["byline_id", "collection_slug", "content_id"])
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await indexExists(db, "idx_content_bylines_byline_collection")) {
		await db.schema.dropIndex("idx_content_bylines_byline_collection").execute();
	}
}
