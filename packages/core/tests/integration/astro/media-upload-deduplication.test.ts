import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMediaCreate } from "../../../src/api/handlers/media.js";
import { POST as postMedia } from "../../../src/astro/routes/api/media.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { computeContentHash } from "../../../src/utils/hash.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const bytes = new Uint8Array([1, 2, 3]);

function uploadRequest(deduplicate?: string): Request {
	const form = new FormData();
	form.set("file", new File([bytes], "photo.png", { type: "image/png" }));
	if (deduplicate !== undefined) form.set("deduplicate", deduplicate);
	return new Request("http://localhost/_emdash/api/media", {
		method: "POST",
		headers: { "X-EmDash-Request": "1" },
		body: form,
	});
}

function buildContext(
	db: Kysely<Database>,
	request: Request,
	upload: ReturnType<typeof vi.fn>,
): APIContext {
	return {
		params: {},
		url: new URL(request.url),
		request,
		locals: {
			emdash: {
				db,
				config: {},
				storage: { upload },
				handleMediaCreate: (input: Parameters<typeof handleMediaCreate>[1]) =>
					handleMediaCreate(db, input),
			},
			user: { id: "author-1", email: "author@example.com", name: "Author", role: 30 },
		},
	} as unknown as APIContext;
}

describe("direct media upload deduplication", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function createExisting() {
		return new MediaRepository(db).create({
			filename: "existing.png",
			mimeType: "image/png",
			size: bytes.byteLength,
			storageKey: "existing.png",
			contentHash: await computeContentHash(bytes),
		});
	}

	it("deduplicates matching bytes by default", async () => {
		const existing = await createExisting();
		const upload = vi.fn();

		const response = await postMedia(buildContext(db, uploadRequest(), upload));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { item: { id: existing.id, storageKey: existing.storageKey }, deduplicated: true },
		});
		expect(upload).not.toHaveBeenCalled();
	});

	it("creates a distinct item and storage key when deduplication is disabled", async () => {
		const existing = await createExisting();
		const upload = vi.fn().mockResolvedValue({ key: "unused", url: "", size: bytes.byteLength });

		const response = await postMedia(buildContext(db, uploadRequest("false"), upload));

		expect(response.status).toBe(201);
		const body = (await response.json()) as {
			data: { item: { id: string; storageKey: string }; deduplicated?: boolean };
		};
		expect(body.data.deduplicated).toBeUndefined();
		expect(body.data.item.id).not.toBe(existing.id);
		expect(body.data.item.storageKey).not.toBe(existing.storageKey);
		expect((await new MediaRepository(db).findMany()).items).toHaveLength(2);
		expect(upload).toHaveBeenCalledOnce();
	});

	it("rejects any multipart deduplication value other than true or false", async () => {
		await createExisting();
		const upload = vi.fn();

		const response = await postMedia(buildContext(db, uploadRequest("False"), upload));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
		expect(upload).not.toHaveBeenCalled();
	});
});
