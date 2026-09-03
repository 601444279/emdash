import { sql, type Kysely } from "kysely";

import { withTransaction } from "../transaction.js";
import type { Database } from "../types.js";
import { validateIdentifier } from "../validate.js";
import { ContentRepository } from "./content.js";
import type { ContentItem, CreateContentInput } from "./types.js";

export class SiteContentRepository {
	private content: ContentRepository;

	constructor(private db: Kysely<Database>) {
		this.content = new ContentRepository(db);
	}

	async create(siteId: string, input: CreateContentInput): Promise<ContentItem> {
		return withTransaction(this.db, async (trx) => {
			const site = await trx
				.selectFrom("_emdash_sites")
				.select("id")
				.where("id", "=", siteId)
				.where("status", "=", "active")
				.executeTakeFirst();
			if (!site) throw new Error("SITE_NOT_FOUND");
			if (
				input.translationOf &&
				!(await this.belongsToSite(siteId, input.type, input.translationOf, trx))
			) {
				throw new Error("SITE_CONTENT_NOT_FOUND");
			}

			const item = await new ContentRepository(trx).create(input);
			await trx
				.insertInto("_emdash_site_content")
				.values({ site_id: siteId, collection: input.type, entry_id: item.id })
				.execute();
			return item;
		});
	}

	async findById(siteId: string, type: string, id: string): Promise<ContentItem | null> {
		return (await this.belongsToSite(siteId, type, id)) ? this.content.findById(type, id) : null;
	}

	async findBySlug(siteId: string, type: string, slug: string): Promise<ContentItem | null> {
		validateIdentifier(type, "collection type");
		const tableName = `ec_${type}`;
		const row = await sql<{ id: string }>`
			SELECT content.id
			FROM ${sql.ref(tableName)} AS content
			INNER JOIN _emdash_site_content AS site_content
				ON site_content.collection = ${type} AND site_content.entry_id = content.id
			WHERE site_content.site_id = ${siteId}
				AND content.slug = ${slug}
				AND content.deleted_at IS NULL
			ORDER BY content.locale ASC
			LIMIT 1
		`.execute(this.db);
		const id = row.rows[0]?.id;
		return id ? this.content.findById(type, id) : null;
	}

	async findByIdentifier(siteId: string, type: string, identifier: string): Promise<ContentItem | null> {
		return (await this.findById(siteId, type, identifier)) ?? this.findBySlug(siteId, type, identifier);
	}

	async listPublished(siteId: string, type: string, limit = 50): Promise<ContentItem[]> {
		return this.list(siteId, type, limit, true);
	}

	async list(
		siteId: string,
		type: string,
		limit = 50,
		publishedOnly = false,
	): Promise<ContentItem[]> {
		validateIdentifier(type, "collection type");
		const tableName = `ec_${type}`;
		const statusFilter = publishedOnly ? sql`AND content.status = 'published'` : sql``;
		const rows = await sql<{ id: string }>`
			SELECT content.id
			FROM ${sql.ref(tableName)} AS content
			INNER JOIN _emdash_site_content AS site_content
				ON site_content.collection = ${type} AND site_content.entry_id = content.id
			WHERE site_content.site_id = ${siteId}
				${statusFilter}
				AND content.deleted_at IS NULL
			ORDER BY content.updated_at DESC, content.id DESC
			LIMIT ${Math.min(Math.max(limit, 1), 100)}
		`.execute(this.db);

		return this.content.findManyByIds(
			type,
			rows.rows.map(({ id }) => id),
		);
	}

	private async belongsToSite(
		siteId: string,
		type: string,
		id: string,
		db: Kysely<Database> = this.db,
	): Promise<boolean> {
		const mapping = await db
			.selectFrom("_emdash_site_content")
			.select("entry_id")
			.where("site_id", "=", siteId)
			.where("collection", "=", type)
			.where("entry_id", "=", id)
			.executeTakeFirst();
		return mapping !== undefined;
	}
}
