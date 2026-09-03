import { sql, type Kysely } from "kysely";

import { currentTimestamp, isSqlite, listTablesLike } from "../dialect-helpers.js";
import { validateIdentifier } from "../validate.js";

const LEGACY_SITE_ID = "01J00000000000000000000000";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		INSERT INTO _emdash_sites (
			id, key, name, status, active_theme_id, active_theme_version, theme_settings
		) VALUES (
			${LEGACY_SITE_ID}, 'legacy', 'Legacy site', 'active', 'editorial', '1.0.0', '{}'
		) ON CONFLICT (key) DO NOTHING
	`.execute(db);

	await db.schema
		.createTable("_emdash_site_content")
		.ifNotExists()
		.addColumn("site_id", "text", (column) =>
			column.notNull().references("_emdash_sites.id").onDelete("cascade"),
		)
		.addColumn("collection", "text", (column) => column.notNull())
		.addColumn("entry_id", "text", (column) => column.notNull())
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.addPrimaryKeyConstraint("pk_emdash_site_content", ["site_id", "collection", "entry_id"])
		.addUniqueConstraint("uq_emdash_site_content_entry", ["collection", "entry_id"])
		.execute();

	await db.schema
		.createIndex("idx_emdash_site_content_site_collection")
		.ifNotExists()
		.on("_emdash_site_content")
		.columns(["site_id", "collection"])
		.execute();

	const tableNames = await listTablesLike(db, "ec_%");
	for (const tableName of tableNames) {
		validateIdentifier(tableName, "content table name");
		const slug = tableName.slice("ec_".length);
		if (isSqlite(db)) {
			await sql`
				INSERT OR IGNORE INTO _emdash_site_content (site_id, collection, entry_id)
				SELECT ${LEGACY_SITE_ID}, ${slug}, id FROM ${sql.ref(tableName)}
			`.execute(db);
		} else {
			await sql`
				INSERT INTO _emdash_site_content (site_id, collection, entry_id)
				SELECT ${LEGACY_SITE_ID}, ${slug}, id FROM ${sql.ref(tableName)}
				ON CONFLICT DO NOTHING
			`.execute(db);
		}
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_site_content").execute();
}
