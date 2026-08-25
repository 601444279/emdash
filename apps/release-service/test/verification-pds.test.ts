import type { ActorResolver } from "@atcute/identity-resolver";
import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import {
	findAuthoritativeRelease,
	PublisherSnapshotError,
	readPublisherVerificationSnapshot,
} from "../src/verification/pds.js";

const PUBLISHER_DID = "did:plc:publisher";

function resolver(): ActorResolver {
	return {
		resolve: async () => ({
			did: PUBLISHER_DID,
			handle: "publisher.example.com",
			pds: "https://pds.example.com",
		}),
	};
}

function release(version: string) {
	return {
		uri: `at://${PUBLISHER_DID}/${NSID.packageRelease}/gallery:${version}`,
		cid: `bafy${version.replaceAll(".", "")}`,
		value: { package: "gallery", version },
	};
}

function snapshotFetch(options: { privateAddress?: boolean; proposedExists?: boolean } = {}) {
	return async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "cloudflare-dns.com") {
			return Response.json({
				Status: 0,
				Answer:
					url.searchParams.get("type") === "A"
						? [{ type: 1, data: options.privateAddress ? "10.0.0.1" : "93.184.216.34" }]
						: [],
			});
		}
		if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
			return Response.json({
				uri: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
				cid: "bafyprofile",
				value: { id: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery` },
			});
		}
		if (url.pathname === "/xrpc/com.atproto.repo.listRecords") {
			expect(url.searchParams.get("rkeyStart")).toBe("gallery:");
			expect(url.searchParams.get("rkeyEnd")).toBe("gallery:~");
			if (url.searchParams.get("cursor") === null) {
				return Response.json({
					records: [release("1.9.0"), release("1.10.0")],
					cursor: "page-2",
				});
			}
			return Response.json({
				records: [release("2.0.0-rc.1"), ...(options.proposedExists ? [release("2.0.0")] : [])],
			});
		}
		throw new Error(`Unexpected request: ${url.toString()}`);
	};
}

function releaseFetch(record: ReturnType<typeof release> | null, options: { error?: string } = {}) {
	return async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "cloudflare-dns.com") {
			return Response.json({
				Status: 0,
				Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.216.34" }] : [],
			});
		}
		expect(url.pathname).toBe("/xrpc/com.atproto.repo.getRecord");
		expect(url.searchParams.get("repo")).toBe(PUBLISHER_DID);
		expect(url.searchParams.get("collection")).toBe(NSID.packageRelease);
		expect(url.searchParams.get("rkey")).toBe("gallery:2.0.0");
		return record
			? Response.json(record)
			: Response.json({ error: options.error ?? "RecordNotFound" }, { status: 400 });
	};
}

describe("publisher verification snapshot", () => {
	it("reads the authoritative profile, proves absence, and selects the highest semver baseline", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: snapshotFetch(),
			}),
		).resolves.toMatchObject({
			profile: { cid: "bafyprofile" },
			proposedRkey: "gallery:2.0.0",
			proposedReleaseAbsent: true,
			baselineVersion: "2.0.0-rc.1",
			baseline: { cid: "bafy200-rc1" },
		});
	});

	it("fails when the deterministic release key already exists", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: snapshotFetch({ proposedExists: true }),
			}),
		).rejects.toMatchObject({ code: "RELEASE_EXISTS" });
	});

	it("rejects private PDS resolution before record egress", async () => {
		await expect(
			readPublisherVerificationSnapshot(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: snapshotFetch({ privateAddress: true }),
			}),
		).rejects.toBeInstanceOf(PublisherSnapshotError);
	});
});

describe("authoritative release reconciliation read", () => {
	it("reads only the deterministic release key and returns its authoritative CID", async () => {
		await expect(
			findAuthoritativeRelease(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: releaseFetch(release("2.0.0")),
			}),
		).resolves.toEqual(release("2.0.0"));
	});

	it("accepts only the explicit RecordNotFound response as confirmed absence", async () => {
		await expect(
			findAuthoritativeRelease(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: releaseFetch(null),
			}),
		).resolves.toBeNull();

		await expect(
			findAuthoritativeRelease(PUBLISHER_DID, "gallery", "2.0.0", {
				actorResolver: resolver(),
				fetch: releaseFetch(null, { error: "InvalidRequest" }),
			}),
		).rejects.toMatchObject({ code: "RELEASE_RECORD_INVALID" });
	});
});
