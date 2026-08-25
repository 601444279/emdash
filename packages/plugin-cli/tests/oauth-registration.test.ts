import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resumeSession, revokeSession } from "../src/oauth.js";

const DID = "did:plc:publisher" as const;

function storedSession() {
	return {
		dpopKey: {
			kty: "EC",
			crv: "P-256",
			alg: "ES256",
			x: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
			y: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
			d: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
		},
		authMethod: { method: "none" },
		tokenSet: {
			iss: "https://authorization.example",
			sub: DID,
			aud: "https://pds.example",
			scope: "atproto",
			access_token: "access-token",
			refresh_token: "refresh-token",
			token_type: "DPoP",
			expires_at: 1,
		},
	};
}

async function writeSession(stateDir: string): Promise<void> {
	await writeFile(
		join(stateDir, "sessions.json"),
		`${JSON.stringify({ version: 1, entries: { [DID]: storedSession() } }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("stored OAuth client registration", () => {
	it("fails before refresh and preserves the session when registration metadata is missing", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "emdash-oauth-registration-"));
		try {
			await writeSession(stateDir);
			vi.stubGlobal(
				"fetch",
				vi.fn(() => {
					throw new Error("refresh must not run without the original client registration");
				}),
			);

			await expect(resumeSession(DID, { stateDir, scope: "atproto" })).rejects.toThrow(
				"Stored OAuth client registration is missing or invalid; sign in again",
			);
			expect(JSON.parse(await readFile(join(stateDir, "sessions.json"), "utf8"))).toMatchObject({
				entries: { [DID]: { tokenSet: { refresh_token: "refresh-token" } } },
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("preserves the session when strict server revocation lacks registration metadata", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "emdash-oauth-registration-"));
		try {
			await writeSession(stateDir);
			await expect(revokeSession(DID, { stateDir, strict: true })).rejects.toThrow(
				"Stored OAuth client registration is missing or invalid; sign in again",
			);
			expect(JSON.parse(await readFile(join(stateDir, "sessions.json"), "utf8"))).toHaveProperty(
				`entries.${DID}`,
			);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});
});
