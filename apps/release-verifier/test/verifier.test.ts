import { computeMultihash } from "@emdash-cms/registry-verification";
import { exports } from "cloudflare:workers";
import { packTar, type TarEntry } from "modern-tar";
import { describe, expect, it, vi } from "vitest";

import { resolvePublicHostname } from "../src/dns.js";
import { verifyArtifact } from "../src/verify.js";

const encoder = new TextEncoder();
const ARTIFACT_URL = "https://artifact.example.test/plugin.tgz";

function file(name: string, body: string): TarEntry {
	const bytes = encoder.encode(body);
	return { header: { name, size: bytes.byteLength, type: "file" }, body: bytes };
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function validBundle(): Promise<Uint8Array> {
	const manifest = {
		id: "gallery",
		version: "1.2.3",
		capabilities: ["write:content"],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [],
		admin: {},
	};
	return gzip(
		await packTar([
			file("manifest.json", JSON.stringify(manifest)),
			file("backend.js", "export default {};"),
			file("admin.js", "export default {};"),
		]),
	);
}

async function checksum(bytes: Uint8Array): Promise<string> {
	const result = await computeMultihash(bytes);
	if (!result.success) throw new Error(result.error.code);
	return result.value;
}

describe("isolated release verifier", () => {
	it("fetches, checksums, and validates a bundle without returning file bytes", async () => {
		const bytes = await validBundle();
		const fetchImplementation = vi.fn(async () => new Response(bytes));
		const result = await verifyArtifact(
			{
				url: ARTIFACT_URL,
				checksum: await checksum(bytes),
				packageSlug: "gallery",
				version: "1.2.3",
			},
			{
				fetch: fetchImplementation,
				resolveHostname: async () => ["203.0.113.5"],
			},
		);

		expect(result).toMatchObject({
			success: true,
			value: {
				url: ARTIFACT_URL,
				compressedBytes: bytes.byteLength,
				manifest: {
					id: "gallery",
					version: "1.2.3",
					declaredAccess: { content: { read: {}, write: {} } },
				},
				bundle: {
					backendBytes: encoder.encode("export default {};").byteLength,
					adminBytes: encoder.encode("export default {};").byteLength,
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain("export default");
	});

	it("rejects checksum and bundle identity mismatches with stable reports", async () => {
		const bytes = await validBundle();
		const dependencies = {
			fetch: async () => new Response(bytes),
			resolveHostname: async () => ["203.0.113.5"],
		};
		const wrongBytes = encoder.encode("different");

		await expect(
			verifyArtifact(
				{
					url: ARTIFACT_URL,
					checksum: await checksum(wrongBytes),
					packageSlug: "gallery",
					version: "1.2.3",
				},
				dependencies,
			),
		).resolves.toMatchObject({ success: false, error: { code: "CHECKSUM_MISMATCH" } });
		await expect(
			verifyArtifact(
				{
					url: ARTIFACT_URL,
					checksum: await checksum(bytes),
					packageSlug: "other",
					version: "1.2.3",
				},
				dependencies,
			),
		).resolves.toMatchObject({ success: false, error: { code: "BUNDLE_ID_MISMATCH" } });
	});

	it("rejects forbidden DNS before artifact fetch", async () => {
		const fetchImplementation = vi.fn(async () => new Response("unreachable"));
		const result = await verifyArtifact(
			{
				url: ARTIFACT_URL,
				checksum: `b${"a".repeat(54)}`,
				packageSlug: "gallery",
				version: "1.2.3",
			},
			{
				fetch: fetchImplementation,
				resolveHostname: async () => ["127.0.0.1"],
			},
		);

		expect(result).toMatchObject({ success: false, error: { code: "HOST_REJECTED" } });
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	it("returns bounded input and archive failures", async () => {
		await expect(
			verifyArtifact(
				{ url: "", checksum: "", packageSlug: "", version: "" },
				{ fetch: fetch, resolveHostname: async () => [] },
			),
		).resolves.toEqual({
			success: false,
			error: { code: "VERIFIER_INPUT_INVALID", message: "Artifact request is invalid" },
		});
		const bytes = encoder.encode("not a bundle");
		await expect(
			verifyArtifact(
				{
					url: ARTIFACT_URL,
					checksum: await checksum(bytes),
					packageSlug: "gallery",
					version: "1.2.3",
				},
				{ fetch: async () => new Response(bytes), resolveHostname: async () => ["203.0.113.5"] },
			),
		).resolves.toMatchObject({ success: false, error: { code: "BUNDLE_INVALID_ARCHIVE" } });
	});

	it("exposes only the typed RPC method and rejects invalid input before egress", async () => {
		await expect(
			exports.default.verifyArtifact({ url: "", checksum: "", packageSlug: "", version: "" }),
		).resolves.toMatchObject({ success: false, error: { code: "VERIFIER_INPUT_INVALID" } });
	});
});

	describe("Cloudflare DNS resolver", () => {
	it("combines bounded A and AAAA answers", async () => {
		const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
			const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			const type = url.searchParams.get("type");
			return Response.json({
				Status: 0,
				Answer: [
					{ type: type === "A" ? 1 : 28, data: type === "A" ? "203.0.113.5" : "2001:db8::5" },
				],
			});
		});

		await expect(resolvePublicHostname("artifact.example", fetchImplementation)).resolves.toEqual([
			"203.0.113.5",
			"2001:db8::5",
		]);
	});
});
