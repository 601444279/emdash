import { sql, type Kysely } from "kysely";

async function hasColumn(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
	const columns = await sql<{ name: string }>`PRAGMA table_info(${sql.ref(table)})`.execute(db);
	return columns.rows.some((current) => current.name === column);
}

export async function up(db: Kysely<unknown>): Promise<void> {
	if (await hasColumn(db, "_emdash_api_tokens", "site_keys")) return;

	await db.schema.alterTable("_emdash_api_tokens").addColumn("site_keys", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("_emdash_api_tokens").dropColumn("site_keys").execute();
}
