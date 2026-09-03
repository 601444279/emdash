import type { Insertable, Kysely, Selectable, Updateable } from "kysely";
import { ulid } from "ulidx";

import { validateThemeSettings } from "../../themes/index.js";
import { withTransaction } from "../transaction.js";
import type { Database, SiteTable } from "../types.js";

type SiteRow = Selectable<SiteTable>;

const SITE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const TRAILING_DOT_PATTERN = /\.$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const UNIQUE_CONSTRAINT_PATTERN = /unique constraint|duplicate key/i;

export type SiteStatus = "active" | "archived";

export interface SiteTheme {
	id: string;
	version: string;
	settings: Record<string, unknown>;
}

export interface Site {
	id: string;
	key: string;
	name: string;
	status: SiteStatus;
	domains: string[];
	theme: SiteTheme;
	createdAt: string;
	updatedAt: string;
}

export interface SiteThemeHistoryEntry {
	id: string;
	theme: SiteTheme;
	createdAt: string;
}

export interface CreateSiteInput {
	key: string;
	name: string;
	domains: string[];
	theme: SiteTheme;
}

export interface UpdateSiteInput {
	name?: string;
	status?: SiteStatus;
	domains?: string[];
	theme?: SiteTheme;
}

export class SiteRepository {
	constructor(private db: Kysely<Database>) {}

	async create(input: CreateSiteInput): Promise<Site> {
		const id = ulid();
		const key = normalizeKey(input.key);
		const domains = normalizeDomains(input.domains);
		const theme = normalizeTheme(input.theme);
		const row: Insertable<SiteTable> = {
			id,
			key,
			name: input.name.trim(),
			status: "active",
			active_theme_id: theme.id,
			active_theme_version: theme.version,
			theme_settings: JSON.stringify(theme.settings),
		};

		try {
			await withTransaction(this.db, async (trx) => {
				await trx.insertInto("_emdash_sites").values(row).execute();
				if (domains.length > 0) {
					await trx
						.insertInto("_emdash_site_domains")
						.values(domains.map((domain) => ({ domain, site_id: id })))
						.execute();
				}
			});
		} catch (error) {
			if (isUniqueConstraint(error)) throw new Error("SITE_DOMAIN_CONFLICT", { cause: error });
			throw error;
		}

		const site = await this.findById(id);
		if (!site) throw new Error("SITE_CREATE_ERROR");
		return site;
	}

	async findById(id: string): Promise<Site | null> {
		const row = await this.db
			.selectFrom("_emdash_sites")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row ? this.toSite(row) : null;
	}

	async findByKey(key: string): Promise<Site | null> {
		const row = await this.db
			.selectFrom("_emdash_sites")
			.selectAll()
			.where("key", "=", normalizeKey(key))
			.executeTakeFirst();
		return row ? this.toSite(row) : null;
	}

	async findByDomain(domain: string): Promise<Site | null> {
		const row = await this.db
			.selectFrom("_emdash_site_domains")
			.innerJoin("_emdash_sites", "_emdash_sites.id", "_emdash_site_domains.site_id")
			.selectAll("_emdash_sites")
			.where("_emdash_site_domains.domain", "=", normalizeDomain(domain))
			.executeTakeFirst();
		return row ? this.toSite(row) : null;
	}

	async list(): Promise<Site[]> {
		const rows = await this.db.selectFrom("_emdash_sites").selectAll().orderBy("name").execute();
		return Promise.all(rows.map((row) => this.toSite(row)));
	}

	async update(id: string, input: UpdateSiteInput): Promise<Site | null> {
		const values: Updateable<SiteTable> = { updated_at: new Date().toISOString() };
		if (input.name !== undefined) values.name = input.name.trim();
		if (input.status !== undefined) values.status = input.status;
		if (input.theme !== undefined) {
			const theme = normalizeTheme(input.theme);
			values.active_theme_id = theme.id;
			values.active_theme_version = theme.version;
			values.theme_settings = JSON.stringify(theme.settings);
		}

		try {
			await withTransaction(this.db, async (trx) => {
				const current = input.theme
					? await trx
							.selectFrom("_emdash_sites")
							.select(["active_theme_id", "active_theme_version", "theme_settings"])
							.where("id", "=", id)
							.executeTakeFirst()
					: undefined;
				if (current && input.theme) {
					const nextTheme = normalizeTheme(input.theme);
					const changed =
						current.active_theme_id !== nextTheme.id ||
						current.active_theme_version !== nextTheme.version ||
						current.theme_settings !== JSON.stringify(nextTheme.settings);
					if (changed) {
						await trx
							.insertInto("_emdash_site_theme_history")
							.values({
								id: ulid(),
								site_id: id,
								theme_id: current.active_theme_id,
								theme_version: current.active_theme_version,
								theme_settings: current.theme_settings,
							})
							.execute();
					}
				}
				if (Object.keys(values).length > 0) {
					await trx.updateTable("_emdash_sites").set(values).where("id", "=", id).execute();
				}
				if (input.domains !== undefined) {
					const domains = normalizeDomains(input.domains);
					await trx.deleteFrom("_emdash_site_domains").where("site_id", "=", id).execute();
					if (domains.length > 0) {
						await trx
							.insertInto("_emdash_site_domains")
							.values(domains.map((domain) => ({ domain, site_id: id })))
							.execute();
					}
				}
			});
		} catch (error) {
			if (isUniqueConstraint(error)) throw new Error("SITE_DOMAIN_CONFLICT", { cause: error });
			throw error;
		}

		return this.findById(id);
	}

	async listThemeHistory(siteId: string): Promise<SiteThemeHistoryEntry[]> {
		const rows = await this.db
			.selectFrom("_emdash_site_theme_history")
			.selectAll()
			.where("site_id", "=", siteId)
			.orderBy("created_at", "desc")
			.execute();
		return rows.map((row) => ({
			id: row.id,
			theme: {
				id: row.theme_id,
				version: row.theme_version,
				settings: JSON.parse(row.theme_settings) as Record<string, unknown>,
			},
			createdAt: row.created_at,
		}));
	}

	async rollbackTheme(siteId: string, historyId: string): Promise<Site | null> {
		const entry = await this.db
			.selectFrom("_emdash_site_theme_history")
			.selectAll()
			.where("id", "=", historyId)
			.where("site_id", "=", siteId)
			.executeTakeFirst();
		if (!entry) return null;
		return this.update(siteId, {
			theme: {
				id: entry.theme_id,
				version: entry.theme_version,
				settings: JSON.parse(entry.theme_settings) as Record<string, unknown>,
			},
		});
	}

	private async toSite(row: SiteRow): Promise<Site> {
		const domains = await this.db
			.selectFrom("_emdash_site_domains")
			.select("domain")
			.where("site_id", "=", row.id)
			.orderBy("domain")
			.execute();
		return {
			id: row.id,
			key: row.key,
			name: row.name,
			status: row.status as SiteStatus,
			domains: domains.map((domain) => domain.domain),
			theme: {
				id: row.active_theme_id,
				version: row.active_theme_version,
				settings: JSON.parse(row.theme_settings) as Record<string, unknown>,
			},
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}
}

function normalizeKey(key: string): string {
	const normalized = key.trim().toLowerCase();
	if (!SITE_KEY_PATTERN.test(normalized)) throw new Error("INVALID_SITE_KEY");
	return normalized;
}

function normalizeDomains(domains: string[]): string[] {
	return [...new Set(domains.map(normalizeDomain))];
}

function normalizeDomain(value: string): string {
	const domain = value.trim().toLowerCase().replace(TRAILING_DOT_PATTERN, "");
	if (!DOMAIN_PATTERN.test(domain)) {
		throw new Error("INVALID_SITE_DOMAIN");
	}
	return domain;
}

function isUniqueConstraint(error: unknown): boolean {
	return error instanceof Error && UNIQUE_CONSTRAINT_PATTERN.test(error.message);
}

function normalizeTheme(theme: SiteTheme): SiteTheme {
	return {
		id: theme.id,
		version: theme.version,
		settings: validateThemeSettings(theme.id, theme.version, theme.settings),
	};
}
