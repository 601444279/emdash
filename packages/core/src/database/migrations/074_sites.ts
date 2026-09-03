import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_sites")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("key", "text", (column) => column.notNull().unique())
		.addColumn("name", "text", (column) => column.notNull())
		.addColumn("status", "text", (column) => column.notNull().defaultTo("active"))
		.addColumn("active_theme_id", "text", (column) => column.notNull())
		.addColumn("active_theme_version", "text", (column) => column.notNull())
		.addColumn("theme_settings", "text", (column) => column.notNull().defaultTo("{}"))
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createTable("_emdash_site_domains")
		.ifNotExists()
		.addColumn("domain", "text", (column) => column.primaryKey())
		.addColumn("site_id", "text", (column) =>
			column.notNull().references("_emdash_sites.id").onDelete("cascade"),
		)
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx_emdash_site_domains_site_id")
		.ifNotExists()
		.on("_emdash_site_domains")
		.column("site_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_site_domains").execute();
	await db.schema.dropTable("_emdash_sites").execute();
}
