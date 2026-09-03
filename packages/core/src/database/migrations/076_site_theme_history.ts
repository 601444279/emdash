import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_site_theme_history")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("site_id", "text", (column) =>
			column.notNull().references("_emdash_sites.id").onDelete("cascade"),
		)
		.addColumn("theme_id", "text", (column) => column.notNull())
		.addColumn("theme_version", "text", (column) => column.notNull())
		.addColumn("theme_settings", "text", (column) => column.notNull())
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx_emdash_site_theme_history_site_created")
		.ifNotExists()
		.on("_emdash_site_theme_history")
		.columns(["site_id", "created_at"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_site_theme_history").execute();
}
