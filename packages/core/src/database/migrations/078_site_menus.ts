import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_site_menus")
		.ifNotExists()
		.addColumn("site_id", "text", (column) => column.notNull())
		.addColumn("menu_id", "text", (column) => column.notNull())
		.addColumn("location", "text", (column) => column.notNull().defaultTo("primary"))
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(sql`(datetime('now'))`))
		.addPrimaryKeyConstraint("emdash_site_menus_pk", ["site_id", "location"])
		.execute();
	await db.schema
		.createIndex("idx_emdash_site_menus_menu")
		.ifNotExists()
		.on("_emdash_site_menus")
		.column("menu_id")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_site_menus").ifExists().execute();
}
