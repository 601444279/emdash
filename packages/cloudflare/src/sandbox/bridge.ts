/**
 * PluginBridge WorkerEntrypoint
 *
 * Provides controlled access to database operations for sandboxed plugins.
 * The sandbox gets a SERVICE BINDING to this entrypoint, not direct DB access.
 * All operations are validated and scoped to the plugin.
 */

import type { R2Bucket } from "@cloudflare/workers-types";
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
	ContentCreateOptions,
	ContentItem,
	Database,
	I18nConfig,
	MediaItem,
	SandboxEmailSendCallback,
} from "emdash";
import {
	ContentRepository,
	createSandboxRouteError,
	getSandboxRouteErrorDetails,
	MediaRepository,
	PluginStorageRepository,
	resolveContentCreateLocale,
	ulid,
	UserRepository,
} from "emdash";
import { type Kysely } from "kysely";

import { withBridgeDb } from "./bridge-db.js";
import { sandboxHttpFetch } from "./bridge-http.js";

/** Regex to validate collection names (prevent SQL injection) */
const COLLECTION_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const MISSING_MEDIA_USAGE_ACTIVATION_TABLE_REGEX = /no such table.*_emdash_media_usage_activation/i;

/** Regex to validate file extensions (simple alphanumeric, 1-10 chars) */
const FILE_EXT_REGEX = /^\.[a-z0-9]{1,10}$/i;

/** System columns that plugins cannot directly write to */
const SYSTEM_COLUMNS = new Set([
	"id",
	"slug",
	"status",
	"author_id",
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
	"version",
	"live_revision_id",
	"draft_revision_id",
	"locale",
	"translation_group",
]);

/**
 * Module-level email send callback.
 *
 * The bridge runs in the host process (same worker), so we can use a
 * module-level callback that the runner sets before creating bridge bindings.
 * This avoids the need to pass non-serializable functions through props.
 *
 * @see runner.ts setEmailSendCallback()
 */
let emailSendCallback: SandboxEmailSendCallback | null = null;

/**
 * Set the email send callback for all bridge instances.
 * Called by the runner when the EmailPipeline is available.
 */
export function setEmailSendCallback(callback: SandboxEmailSendCallback | null): void {
	emailSendCallback = callback;
}

/**
 * Deserialize a row into a ContentItem matching core's plugin API.
 * Extracts system columns, deserializes JSON fields, and returns the
 * canonical shape: { id, type, data, createdAt, updatedAt, locale }.
 */
function rowToContentItem(
	collection: string,
	row: Record<string, unknown>,
): {
	id: string;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	locale: string;
} {
	const data: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (!SYSTEM_COLUMNS.has(key)) {
			// Attempt to parse JSON strings back to objects
			if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
				try {
					data[key] = JSON.parse(value);
				} catch {
					data[key] = value;
				}
			} else if (value !== null) {
				data[key] = value;
			}
		}
	}

	return {
		id: typeof row.id === "string" ? row.id : String(row.id),
		type: collection,
		data,
		createdAt: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
		updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
		locale: typeof row.locale === "string" ? row.locale : "en",
	};
}

/** Narrow an unknown database column value to a string ("" when it isn't one). */
function columnString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Narrow an unknown, nullable column value to `string | null`. */
function columnNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Parse a JSON string column into a string array (`[]` on anything else). */
function columnStringArray(value: unknown): string[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

/** Type guard for plain JSON objects. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a JSON string column into an object (`null` on anything else). */
function columnJsonObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return isJsonObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Convert a `taxonomies` row to the term shape exposed over the bridge.
 * Matches core's TaxonomyTermInfo from plugins/types.ts.
 */
function rowToTaxonomyTerm(row: Record<string, unknown>): {
	id: string;
	taxonomy: string;
	slug: string;
	label: string;
	parentId: string | null;
	data: Record<string, unknown> | null;
	locale: string;
	translationGroup: string | null;
} {
	return {
		id: columnString(row.id),
		taxonomy: columnString(row.name),
		slug: columnString(row.slug),
		label: columnString(row.label),
		parentId: columnNullableString(row.parent_id),
		data: columnJsonObject(row.data),
		locale: columnString(row.locale),
		translationGroup: columnNullableString(row.translation_group),
	};
}

function contentItemToBridgeItem(item: ContentItem): {
	id: string;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	locale: string;
} {
	return {
		id: item.id,
		type: item.type,
		data: item.data,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		locale: item.locale ?? "en",
	};
}

function mediaItemToBridgeItem(item: MediaItem): {
	id: string;
	filename: string;
	mimeType: string;
	size: number | null;
	url: string;
	createdAt: string;
} {
	return {
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		size: item.size,
		url: `/_emdash/api/media/file/${item.storageKey}`,
		createdAt: item.createdAt,
	};
}

interface BridgeUser {
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
}

function userToBridgeItem(user: BridgeUser): {
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
} {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		createdAt: user.createdAt,
	};
}

/**
 * Environment bindings required by PluginBridge
 */
export interface PluginBridgeEnv {
	MEDIA?: R2Bucket;
}

/**
 * Props passed to the bridge via ctx.props when creating the loopback binding
 */
export interface PluginBridgeProps {
	pluginId: string;
	pluginVersion: string;
	capabilities: string[];
	allowedHosts: string[];
	storageCollections: string[];
	i18nConfig?: I18nConfig | null;
	/** Per-collection storage config (matches manifest.storage entries) */
	storageConfig?: Record<
		string,
		{ indexes?: Array<string | string[]>; uniqueIndexes?: Array<string | string[]> }
	>;
}

/**
 * PluginBridge WorkerEntrypoint
 *
 * Provides the context API to sandboxed plugins via RPC.
 * All methods validate capabilities and scope operations to the plugin.
 *
 * Usage:
 * 1. Export this class from your worker entrypoint
 * 2. Sandboxed plugins get a binding to it via ctx.exports.PluginBridge({...})
 * 3. Plugins call bridge methods which validate and proxy to the database
 */
export class PluginBridge extends WorkerEntrypoint<PluginBridgeEnv, PluginBridgeProps> {
	private async assertMediaUsageActivationWriteAllowed(db: Kysely<Database>): Promise<void> {
		try {
			const activation = await db
				.selectFrom("_emdash_media_usage_activation")
				.select("state")
				.where("task_key", "=", "incremental_capture")
				.executeTakeFirst();
			if (activation?.state === "activating") {
				throw createSandboxRouteError("MEDIA_USAGE_ACTIVATION_IN_PROGRESS");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (MISSING_MEDIA_USAGE_ACTIVATION_TABLE_REGEX.test(message)) return;
			if (getSandboxRouteErrorDetails(error)) throw error;
			console.error("[media-usage] Failed to check the sandbox write fence:", error);
			throw createSandboxRouteError("MEDIA_USAGE_ACTIVATION_CHECK_FAILED");
		}
	}

	/**
	 * Construct a PluginStorageRepository for the requested collection.
	 * Uses the indexes from the plugin's storage config (if provided) so
	 * query/count operations support WHERE/ORDER BY/cursor pagination
	 * matching in-process and workerd sandbox plugins.
	 */
	private getStorageRepo(
		db: Kysely<Database>,
		collection: string,
	): PluginStorageRepository<unknown> {
		const { pluginId, storageConfig } = this.ctx.props;
		const config = storageConfig?.[collection];
		// Merge unique indexes into the indexes list since both are queryable
		const allIndexes: Array<string | string[]> = [
			...(config?.indexes ?? []),
			...(config?.uniqueIndexes ?? []),
		];
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Kysely<Database> is compatible with PluginStorageRepository's expected db
		return new PluginStorageRepository(db as never, pluginId, collection, allIndexes);
	}

	// =========================================================================
	// KV Operations - scoped to plugin namespace
	// =========================================================================

	/**
	 * KV operations use _plugin_storage with a special "__kv" collection.
	 * This provides consistent storage across sandboxed and non-sandboxed modes.
	 */
	async kvGet(key: string): Promise<unknown> {
		const { pluginId } = this.ctx.props;
		return withBridgeDb({ isWrite: false }, async (db) => {
			const row = await db
				.selectFrom("_plugin_storage")
				.select("data")
				.where("plugin_id", "=", pluginId)
				.where("collection", "=", "__kv")
				.where("id", "=", key)
				.executeTakeFirst();
			if (!row?.data) return null;
			try {
				return JSON.parse(row.data as string);
			} catch {
				return row.data;
			}
		});
	}

	async kvSet(key: string, value: unknown): Promise<void> {
		const { pluginId } = this.ctx.props;
		return withBridgeDb({ isWrite: true }, async (db) => {
			const now = new Date().toISOString();
			await db
				.insertInto("_plugin_storage")
				.values({
					plugin_id: pluginId,
					collection: "__kv",
					id: key,
					data: JSON.stringify(value),
					updated_at: now,
				})
				.onConflict((oc) =>
					oc.columns(["plugin_id", "collection", "id"]).doUpdateSet({
						data: JSON.stringify(value),
						updated_at: now,
					}),
				)
				.execute();
		});
	}

	async kvDelete(key: string): Promise<boolean> {
		const { pluginId } = this.ctx.props;
		return withBridgeDb({ isWrite: true }, async (db) => {
			const result = await db
				.deleteFrom("_plugin_storage")
				.where("plugin_id", "=", pluginId)
				.where("collection", "=", "__kv")
				.where("id", "=", key)
				.executeTakeFirst();
			return (result.numDeletedRows ?? 0n) > 0n;
		});
	}

	async kvList(prefix: string = ""): Promise<Array<{ key: string; value: unknown }>> {
		const { pluginId } = this.ctx.props;
		return withBridgeDb({ isWrite: false }, async (db) => {
			const rows = await db
				.selectFrom("_plugin_storage")
				.select(["id", "data"])
				.where("plugin_id", "=", pluginId)
				.where("collection", "=", "__kv")
				.where("id", "like", `${prefix}%`)
				.execute();

			return rows.map((row) => ({
				key: row.id,
				value: JSON.parse(row.data as string) as unknown,
			}));
		});
	}

	// =========================================================================
	// Storage Operations - scoped to plugin + collection validation
	// =========================================================================

	async storageGet(collection: string, id: string): Promise<unknown> {
		const { storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			return this.getStorageRepo(db, collection).get(id);
		});
	}

	async storagePut(collection: string, id: string, data: unknown): Promise<void> {
		const { storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return withBridgeDb({ isWrite: true }, async (db) => {
			await this.getStorageRepo(db, collection).put(id, data);
		});
	}

	async storageDelete(collection: string, id: string): Promise<boolean> {
		const { storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return withBridgeDb({ isWrite: true }, async (db) => {
			return this.getStorageRepo(db, collection).delete(id);
		});
	}

	async storageQuery(
		collection: string,
		opts: {
			limit?: number;
			cursor?: string;
			where?: Record<string, unknown>;
			orderBy?: Record<string, "asc" | "desc">;
		} = {},
	): Promise<{
		items: Array<{ id: string; data: unknown }>;
		hasMore: boolean;
		cursor?: string;
	}> {
		const { storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			// Delegate to PluginStorageRepository for proper WHERE/ORDER BY/cursor support
			const repo = this.getStorageRepo(db, collection);
			const result = await repo.query({
				// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- WhereClause is structurally Record<string, unknown>
				where: opts.where as never,
				orderBy: opts.orderBy,
				limit: opts.limit,
				cursor: opts.cursor,
			});
			return {
				items: result.items,
				hasMore: result.hasMore,
				cursor: result.cursor,
			};
		});
	}

	async storageCount(collection: string, where?: Record<string, unknown>): Promise<number> {
		const { storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			const repo = this.getStorageRepo(db, collection);
			// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- WhereClause is structurally Record<string, unknown>
			return repo.count(where as never);
		});
	}

	async storageGetMany(collection: string, ids: string[]): Promise<Map<string, unknown>> {
		const { storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			return this.getStorageRepo(db, collection).getMany(ids);
		});
	}

	async storagePutMany(
		collection: string,
		items: Array<{ id: string; data: unknown }>,
	): Promise<void> {
		const { storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return withBridgeDb({ isWrite: true }, async (db) => {
			await this.getStorageRepo(db, collection).putMany(items);
		});
	}

	async storageDeleteMany(collection: string, ids: string[]): Promise<number> {
		const { storageCollections } = this.ctx.props;
		if (!storageCollections.includes(collection)) {
			throw new Error(`Storage collection not declared: ${collection}`);
		}
		return withBridgeDb({ isWrite: true }, async (db) => {
			return this.getStorageRepo(db, collection).deleteMany(ids);
		});
	}

	// =========================================================================
	// Content Operations - capability-gated
	// =========================================================================

	async contentGet(
		collection: string,
		id: string,
	): Promise<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		createdAt: string;
		updatedAt: string;
		locale: string;
	} | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("content:read")) {
			throw new Error("Missing capability: content:read");
		}
		// Validate collection name to prevent SQL injection
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			const item = await new ContentRepository(db).findById(collection, id);
			return item ? contentItemToBridgeItem(item) : null;
		});
	}

	async contentList(
		collection: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<{
		items: Array<{
			id: string;
			type: string;
			data: Record<string, unknown>;
			createdAt: string;
			updatedAt: string;
			locale: string;
		}>;
		cursor?: string;
		hasMore: boolean;
	}> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("content:read")) {
			throw new Error("Missing capability: content:read");
		}
		// Validate collection name to prevent SQL injection
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		const limit = Math.min(opts.limit ?? 50, 100);
		return withBridgeDb({ isWrite: false }, async (db) => {
			// Content tables use ec_${collection} naming (no leading underscore)
			// Exclude soft-deleted items. Ordered by ULID (id DESC) for deterministic
			// cursor pagination. ULIDs are time-sortable so this approximates created_at DESC.
			let query = db
				.selectFrom(`ec_${collection}` as keyof Database)
				.selectAll()
				.where("deleted_at", "is", null);

			if (opts.cursor) {
				query = query.where("id", "<", opts.cursor);
			}

			const rows = await query
				.orderBy("id", "desc")
				.limit(limit + 1)
				.execute();

			const pageRows = rows.slice(0, limit);
			const items = pageRows.map((row) =>
				rowToContentItem(collection, row as Record<string, unknown>),
			);
			const hasMore = rows.length > limit;

			return {
				items,
				cursor: hasMore && items.length > 0 ? items.at(-1)!.id : undefined,
				hasMore,
			};
		});
	}

	async contentCreate(
		collection: string,
		data: Record<string, unknown>,
		options?: ContentCreateOptions,
	): Promise<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		createdAt: string;
		updatedAt: string;
		locale: string;
	}> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("content:write")) {
			throw new Error("Missing capability: content:write");
		}
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		const locale = resolveContentCreateLocale(options?.locale, this.ctx.props.i18nConfig ?? null);

		return withBridgeDb({ isWrite: true }, async (db) => {
			await this.assertMediaUsageActivationWriteAllowed(db);

			const created = await new ContentRepository(db).create({
				type: collection,
				data,
				status: typeof data.status === "string" ? data.status : "draft",
				slug: typeof data.slug === "string" ? data.slug : undefined,
				authorId: typeof data.author_id === "string" ? data.author_id : undefined,
				locale,
			});

			return contentItemToBridgeItem(created);
		});
	}

	async contentUpdate(
		collection: string,
		id: string,
		data: Record<string, unknown>,
	): Promise<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		createdAt: string;
		updatedAt: string;
		locale: string;
	}> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("content:write")) {
			throw new Error("Missing capability: content:write");
		}
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		return withBridgeDb({ isWrite: true }, async (db) => {
			await this.assertMediaUsageActivationWriteAllowed(db);
			const updated = await new ContentRepository(db).updateDraftAware(collection, id, {
				data,
				status: typeof data.status === "string" ? data.status : undefined,
				slug:
					data.slug === undefined ? undefined : typeof data.slug === "string" ? data.slug : null,
			});
			return contentItemToBridgeItem(updated);
		});
	}

	async contentDelete(collection: string, id: string): Promise<boolean> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("content:write")) {
			throw new Error("Missing capability: content:write");
		}
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
		return withBridgeDb({ isWrite: true }, async (db) => {
			await this.assertMediaUsageActivationWriteAllowed(db);
			return new ContentRepository(db).delete(collection, id);
		});
	}

	// =========================================================================
	// Taxonomy Operations (read-only) - gated on taxonomies:read
	// =========================================================================

	async taxonomyList(opts: { locale?: string } = {}): Promise<
		Array<{
			name: string;
			label: string;
			labelSingular: string | null;
			hierarchical: boolean;
			collections: string[];
			locale: string;
		}>
	> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("taxonomies:read")) {
			throw new Error("Missing capability: taxonomies:read");
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			let query = db.selectFrom("_emdash_taxonomy_defs").selectAll().orderBy("name", "asc");
			if (opts.locale !== undefined) {
				query = query.where("locale", "=", opts.locale);
			}
			const rows = await query.execute();
			return rows.map((row) => ({
				name: columnString(row.name),
				label: columnString(row.label),
				labelSingular: columnNullableString(row.label_singular),
				hierarchical: row.hierarchical === 1,
				collections: columnStringArray(row.collections),
				locale: columnString(row.locale),
			}));
		});
	}

	async taxonomyTerms(
		taxonomy: string,
		opts: { locale?: string } = {},
	): Promise<
		Array<{
			id: string;
			taxonomy: string;
			slug: string;
			label: string;
			parentId: string | null;
			data: Record<string, unknown> | null;
			locale: string;
			translationGroup: string | null;
		}>
	> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("taxonomies:read")) {
			throw new Error("Missing capability: taxonomies:read");
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			let query = db.selectFrom("taxonomies").selectAll().where("name", "=", taxonomy);
			if (opts.locale !== undefined) {
				query = query.where("locale", "=", opts.locale);
			}
			// Manual order first, then label with `id ASC` as a stable tiebreaker for
			// terms sharing both — matching core's TaxonomyRepository.findByName.
			const rows = await query
				.orderBy("sort_order", "asc")
				.orderBy("label", "asc")
				.orderBy("id", "asc")
				.execute();
			return rows.map(rowToTaxonomyTerm);
		});
	}

	async taxonomyEntryTerms(
		collection: string,
		entryId: string,
		opts: { taxonomy?: string; locale?: string } = {},
	): Promise<
		Array<{
			id: string;
			taxonomy: string;
			slug: string;
			label: string;
			parentId: string | null;
			data: Record<string, unknown> | null;
			locale: string;
			translationGroup: string | null;
		}>
	> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("taxonomies:read")) {
			throw new Error("Missing capability: taxonomies:read");
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			// The pivot stores the term's translation_group in taxonomy_id, so the
			// join resolves an assignment into each locale's term row.
			let query = db
				.selectFrom("content_taxonomies")
				.innerJoin("taxonomies", "taxonomies.translation_group", "content_taxonomies.taxonomy_id")
				.selectAll("taxonomies")
				.where("content_taxonomies.collection", "=", collection)
				.where("content_taxonomies.entry_id", "=", entryId);

			if (opts.taxonomy !== undefined) {
				query = query.where("taxonomies.name", "=", opts.taxonomy);
			}
			if (opts.locale !== undefined) {
				query = query.where("taxonomies.locale", "=", opts.locale);
			}

			const rows = await query.orderBy("taxonomies.locale", "asc").execute();
			return rows.map(rowToTaxonomyTerm);
		});
	}

	// =========================================================================
	// Media Operations - capability-gated
	// =========================================================================

	async mediaGet(id: string): Promise<{
		id: string;
		filename: string;
		mimeType: string;
		size: number | null;
		url: string;
		createdAt: string;
	} | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("media:read")) {
			throw new Error("Missing capability: media:read");
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			const item = await new MediaRepository(db).findById(id);
			return item ? mediaItemToBridgeItem(item) : null;
		});
	}

	async mediaList(opts: { limit?: number; cursor?: string; mimeType?: string } = {}): Promise<{
		items: Array<{
			id: string;
			filename: string;
			mimeType: string;
			size: number | null;
			url: string;
			createdAt: string;
		}>;
		cursor?: string;
		hasMore: boolean;
	}> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("media:read")) {
			throw new Error("Missing capability: media:read");
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			const result = await new MediaRepository(db).findMany({
				limit: opts.limit,
				cursor: opts.cursor,
				mimeType: opts.mimeType,
			});
			return {
				items: result.items.map(mediaItemToBridgeItem),
				cursor: result.nextCursor,
				hasMore: result.nextCursor !== undefined,
			};
		});
	}

	/**
	 * Create a pending media record and write bytes directly to R2.
	 *
	 * Unlike the admin UI flow (presigned URL → client PUT → confirm), sandboxed
	 * plugins are network-isolated and can't make external requests. The bridge
	 * accepts the file bytes directly and writes them to storage.
	 *
	 * Returns the media ID, storage key, and confirm URL. The plugin should
	 * call the confirm endpoint after this to finalize the record.
	 */
	async mediaUpload(
		filename: string,
		contentType: string,
		bytes: ArrayBuffer,
	): Promise<{ mediaId: string; storageKey: string; url: string }> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("media:write")) {
			throw new Error("Missing capability: media:write");
		}

		if (!this.env.MEDIA) {
			throw new Error("Media storage (R2) not configured. Add MEDIA binding to wrangler config.");
		}

		// Validate MIME type — only allow image, video, audio, and PDF
		const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/", "application/pdf"];
		if (!ALLOWED_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
			throw new Error(
				`Unsupported content type: ${contentType}. Allowed: image/*, video/*, audio/*, application/pdf`,
			);
		}

		// Derive extension from basename only, validate it's a simple extension
		const basename = filename.includes("/")
			? filename.slice(filename.lastIndexOf("/") + 1)
			: filename;
		const rawExt = basename.includes(".") ? basename.slice(basename.lastIndexOf(".")) : "";
		const ext = FILE_EXT_REGEX.test(rawExt) ? rawExt : "";
		// Flat storage key matching core convention: ${ulid}${ext}
		const mediaId = ulid();
		const storageKey = `${mediaId}${ext}`;

		// Write bytes to R2 first, then create DB record.
		// If DB insert fails, clean up the R2 object to prevent orphans.
		await this.env.MEDIA.put(storageKey, bytes, {
			httpMetadata: { contentType },
		});

		try {
			return await withBridgeDb({ isWrite: true }, async (db) => {
				await new MediaRepository(db).create({
					filename,
					mimeType: contentType,
					size: bytes.byteLength,
					storageKey,
					status: "ready",
				});
				return {
					mediaId,
					storageKey,
					url: `/_emdash/api/media/file/${storageKey}`,
				};
			});
		} catch (error) {
			// Clean up R2 object on DB failure to prevent orphans
			try {
				await this.env.MEDIA.delete(storageKey);
			} catch {
				// Best-effort cleanup — log and continue
				console.warn(`[plugin-bridge] Failed to clean up orphaned R2 object: ${storageKey}`);
			}
			throw error;
		}
	}

	async mediaDelete(id: string): Promise<boolean> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("media:write")) {
			throw new Error("Missing capability: media:write");
		}

		return withBridgeDb({ isWrite: true }, async (db) => {
			const storageKey = await new MediaRepository(db).deleteWithStorageKey(id);

			// Delete from R2 if the binding is available
			if (this.env.MEDIA && storageKey) {
				try {
					await this.env.MEDIA.delete(storageKey);
				} catch {
					// Log but don't fail - the DB row is already deleted
					console.warn(`[plugin-bridge] Failed to delete R2 object: ${storageKey}`);
				}
			}

			return storageKey !== null;
		});
	}

	// =========================================================================
	// Network Operations - capability-gated + host validation
	// =========================================================================

	async httpFetch(
		url: string,
		init?: RequestInit,
	): Promise<{
		status: number;
		headers: Record<string, string>;
		text: string;
	}> {
		const { capabilities, allowedHosts } = this.ctx.props;
		return sandboxHttpFetch(url, init, { capabilities, allowedHosts });
	}

	// =========================================================================
	// User Operations - capability-gated (users:read)
	// =========================================================================

	async userGet(id: string): Promise<{
		id: string;
		email: string;
		name: string | null;
		role: number;
		createdAt: string;
	} | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("users:read")) {
			throw new Error("Missing capability: users:read");
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			const user = await new UserRepository(db).findById(id);
			return user ? userToBridgeItem(user) : null;
		});
	}

	async userGetByEmail(email: string): Promise<{
		id: string;
		email: string;
		name: string | null;
		role: number;
		createdAt: string;
	} | null> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("users:read")) {
			throw new Error("Missing capability: users:read");
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			const user = await new UserRepository(db).findByEmail(email);
			return user ? userToBridgeItem(user) : null;
		});
	}

	async userList(opts?: { role?: number; limit?: number; cursor?: string }): Promise<{
		items: Array<{
			id: string;
			email: string;
			name: string | null;
			role: number;
			createdAt: string;
		}>;
		nextCursor?: string;
	}> {
		const { capabilities } = this.ctx.props;
		if (!capabilities.includes("users:read")) {
			throw new Error("Missing capability: users:read");
		}
		return withBridgeDb({ isWrite: false }, async (db) => {
			const result = await new UserRepository(db).findMany({
				// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- bridge accepts any numeric role; repository narrows to known levels
				role: opts?.role as never,
				limit: opts?.limit,
				cursor: opts?.cursor,
			});
			return {
				items: result.items.map(userToBridgeItem),
				nextCursor: result.nextCursor,
			};
		});
	}

	// =========================================================================
	// Email Operations - capability-gated
	// =========================================================================

	async emailSend(message: {
		to: string;
		subject: string;
		text: string;
		html?: string;
	}): Promise<void> {
		const { capabilities, pluginId } = this.ctx.props;
		if (!capabilities.includes("email:send")) {
			throw new Error("Missing capability: email:send");
		}
		if (!emailSendCallback) {
			throw new Error("Email is not configured. No email provider is available.");
		}
		await emailSendCallback(message, pluginId);
	}

	// =========================================================================
	// Logging
	// =========================================================================

	log(level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown): void {
		const { pluginId } = this.ctx.props;
		console[level](`[plugin:${pluginId}]`, msg, data ?? "");
	}
}
