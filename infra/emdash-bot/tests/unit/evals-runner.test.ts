import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchIssue } from "../../evals/src/runner.ts";

afterEach(() => vi.unstubAllGlobals());

describe("fetchIssue", () => {
	test("reads a public issue without GitHub credentials", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ title: "Issue title", body: "Issue body" }), {
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchIssue({ owner: "emdash-cms", repo: "emdash" }, 917)).resolves.toEqual({
			title: "Issue title",
			body: "Issue body",
		});

		const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
		expect(headers.has("authorization")).toBe(false);
	});

	test("uses a GitHub token when the operator supplies one", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ title: "Issue title", body: null }), {
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await fetchIssue({ owner: "emdash-cms", repo: "emdash", githubToken: "token" }, 917);

		const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
		expect(headers.get("authorization")).toBe("Bearer token");
	});
});
