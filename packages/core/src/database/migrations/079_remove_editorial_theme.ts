import { type Kysely, sql } from "kysely";

const RANKED_SETTINGS = JSON.stringify({
	palette: "forest",
	font: "serif",
	cardStyle: "elevated",
	navigation: "inline",
	footer: "columns",
});

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		UPDATE _emdash_sites
		SET active_theme_id = ${"ranked"},
			active_theme_version = ${"1.0.0"},
			theme_settings = ${RANKED_SETTINGS},
			updated_at = ${new Date().toISOString()}
		WHERE active_theme_id = ${"editorial"}
	`.execute(db);
	await sql`DELETE FROM _emdash_site_theme_history WHERE theme_id = ${"editorial"}`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
