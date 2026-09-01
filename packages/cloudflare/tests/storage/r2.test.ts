import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { R2Storage } from "../../src/storage/r2.js";

describe("R2Storage same-key upload", () => {
	it("replaces the object bytes without changing the key", async () => {
		const objects = new Map<string, Uint8Array>();
		const bucket = {
			async put(key: string, body: Uint8Array) {
				objects.set(key, body);
				return { size: body.byteLength };
			},
		} as unknown as R2Bucket;
		const storage = new R2Storage(bucket);

		await storage.upload({
			key: "hero.png",
			body: new Uint8Array([1, 2, 3]),
			contentType: "image/png",
		});
		await storage.upload({
			key: "hero.png",
			body: new Uint8Array([9, 8]),
			contentType: "image/png",
		});

		expect(objects.get("hero.png")).toEqual(new Uint8Array([9, 8]));
	});
});
