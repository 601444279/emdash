/**
 * API token management handlers.
 *
 * Creates, lists, and revokes Personal Access Tokens (PATs).
 * Token format: ec_pat_<base64url>
 * Only the SHA-256 hash is stored — raw token shown once at creation.
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { hashApiToken, generatePrefixedToken } from "../../auth/api-tokens.js";
import type { Database } from "../../database/types.js";
import type { ApiResult } from "../types.js";

const SITE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiTokenInfo {
	id: string;
	name: string;
	prefix: string;
	scopes: string[];
	siteKeys: string[] | null;
	userId: string;
	expiresAt: string | null;
	lastUsedAt: string | null;
	createdAt: string;
}

export interface ApiTokenCreateResult {
	/** The raw token — shown once, never stored */
	token: string;
	/** Token metadata */
	info: ApiTokenInfo;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Create a new API token for a user.
 */
export async function handleApiTokenCreate(
	db: Kysely<Database>,
	userId: string,
	input: {
		name: string;
		scopes: string[];
		siteKeys?: string[];
		expiresAt?: string;
	},
): Promise<ApiResult<ApiTokenCreateResult>> {
	try {
		const id = ulid();
		const { raw, hash, prefix } = generatePrefixedToken("ec_pat_");

		const siteKeys = normalizeSiteKeys(input.siteKeys);

		await db
			.insertInto("_emdash_api_tokens")
			.values({
				id,
				name: input.name,
				token_hash: hash,
				prefix,
				user_id: userId,
				scopes: JSON.stringify(input.scopes),
				site_keys: siteKeys === null ? null : JSON.stringify(siteKeys),
				expires_at: input.expiresAt ?? null,
			})
			.execute();

		const info: ApiTokenInfo = {
			id,
			name: input.name,
			prefix,
			scopes: input.scopes,
			siteKeys,
			userId,
			expiresAt: input.expiresAt ?? null,
			lastUsedAt: null,
			createdAt: new Date().toISOString(),
		};

		return { success: true, data: { token: raw, info } };
	} catch {
		return {
			success: false,
			error: {
				code: "TOKEN_CREATE_ERROR",
				message: "Failed to create API token",
			},
		};
	}
}

/**
 * List all API tokens for a user (never returns the raw token or hash).
 */
export async function handleApiTokenList(
	db: Kysely<Database>,
	userId: string,
): Promise<ApiResult<{ items: ApiTokenInfo[] }>> {
	try {
		const rows = await db
			.selectFrom("_emdash_api_tokens")
			.select([
				"id",
				"name",
				"prefix",
				"scopes",
				"site_keys",
				"user_id",
				"expires_at",
				"last_used_at",
				"created_at",
			])
			.where("user_id", "=", userId)
			.orderBy("created_at", "desc")
			.execute();

		const items: ApiTokenInfo[] = rows.map((row) => ({
			id: row.id,
			name: row.name,
			prefix: row.prefix,
			scopes: JSON.parse(row.scopes) as string[],
			siteKeys: parseSiteKeys(row.site_keys),
			userId: row.user_id,
			expiresAt: row.expires_at,
			lastUsedAt: row.last_used_at,
			createdAt: row.created_at,
		}));

		return { success: true, data: { items } };
	} catch {
		return {
			success: false,
			error: {
				code: "TOKEN_LIST_ERROR",
				message: "Failed to list API tokens",
			},
		};
	}
}

/**
 * Revoke (delete) an API token.
 */
export async function handleApiTokenRevoke(
	db: Kysely<Database>,
	tokenId: string,
	userId: string,
): Promise<ApiResult<{ revoked: boolean }>> {
	try {
		const result = await db
			.deleteFrom("_emdash_api_tokens")
			.where("id", "=", tokenId)
			.where("user_id", "=", userId)
			.executeTakeFirst();

		if (result.numDeletedRows === 0n) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Token not found" },
			};
		}

		return { success: true, data: { revoked: true } };
	} catch {
		return {
			success: false,
			error: {
				code: "TOKEN_REVOKE_ERROR",
				message: "Failed to revoke API token",
			},
		};
	}
}

/**
 * Delete every token with the given name for a user, returning how many were
 * removed. Token names aren't unique, so this is a bulk delete — used by the
 * dev-bypass flow to keep a single `dev-bypass-token` instead of minting a new
 * one on every reset.
 */
export async function deleteApiTokensByName(
	db: Kysely<Database>,
	userId: string,
	name: string,
): Promise<number> {
	const result = await db
		.deleteFrom("_emdash_api_tokens")
		.where("user_id", "=", userId)
		.where("name", "=", name)
		.executeTakeFirst();
	return Number(result.numDeletedRows ?? 0n);
}

/**
 * Resolve a raw API token (ec_pat_...) to a user ID and scopes.
 * Updates last_used_at on successful lookup.
 * Returns null if the token is invalid or expired.
 */
export async function resolveApiToken(
	db: Kysely<Database>,
	rawToken: string,
): Promise<{ userId: string; scopes: string[]; siteKeys: string[] | null } | null> {
	const hash = hashApiToken(rawToken);

	const row = await db
		.selectFrom("_emdash_api_tokens")
		.select(["id", "user_id", "scopes", "site_keys", "expires_at"])
		.where("token_hash", "=", hash)
		.executeTakeFirst();

	if (!row) return null;

	// Check expiry
	if (row.expires_at && new Date(row.expires_at) < new Date()) {
		return null;
	}

	// Update last_used_at (fire-and-forget, don't block the request)
	db.updateTable("_emdash_api_tokens")
		.set({ last_used_at: new Date().toISOString() })
		.where("id", "=", row.id)
		.execute()
		.catch(() => {}); // Non-critical, swallow errors

	return {
		userId: row.user_id,
		scopes: JSON.parse(row.scopes) as string[],
		siteKeys: parseSiteKeys(row.site_keys),
	};
}

function normalizeSiteKeys(siteKeys: string[] | undefined): string[] | null {
	if (siteKeys === undefined) return null;

	const normalized = [...new Set(siteKeys.map((siteKey) => siteKey.trim().toLowerCase()))];
	if (normalized.some((siteKey) => !SITE_KEY_PATTERN.test(siteKey))) {
		throw new Error("Invalid site key");
	}
	return normalized;
}

function parseSiteKeys(value: string | null): string[] | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed) && parsed.every((siteKey) => typeof siteKey === "string")) {
			return parsed;
		}
	} catch {
		// Treat malformed restrictions as no authorized sites.
	}
	return [];
}

/**
 * Resolve an OAuth access token (ec_oat_...) to a user ID and scopes.
 * Returns null if the token is invalid or expired.
 */
export async function resolveOAuthToken(
	db: Kysely<Database>,
	rawToken: string,
): Promise<{ userId: string; scopes: string[] } | null> {
	const hash = hashApiToken(rawToken);

	const row = await db
		.selectFrom("_emdash_oauth_tokens")
		.select(["user_id", "scopes", "expires_at", "token_type"])
		.where("token_hash", "=", hash)
		.where("token_type", "=", "access")
		.executeTakeFirst();

	if (!row) return null;

	// Check expiry
	if (new Date(row.expires_at) < new Date()) {
		return null;
	}

	return {
		userId: row.user_id,
		scopes: JSON.parse(row.scopes) as string[],
	};
}
