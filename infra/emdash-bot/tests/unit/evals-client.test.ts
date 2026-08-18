import { afterEach, describe, expect, test, vi } from "vitest";

import { BOT_MODELS } from "../../.flue/lib/models.js";
import {
	dispatchInvestigation,
	extractInvestigationResult,
	waitForResult,
	type Snapshot,
} from "../../evals/src/client.ts";

const REPORTED = {
	result: { reproduced: true, summary: "reproduced the bug" },
	ok: true,
	pushed: false,
	runId: "run-1",
	publication: null,
	verification: [],
};

afterEach(() => vi.unstubAllGlobals());

test("dispatch includes the selected eval model in initial data", async () => {
	const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
		new Response(JSON.stringify({ submissionId: "submission-1" }), {
			status: 202,
			headers: { "content-type": "application/json" },
		}),
	);
	vi.stubGlobal("fetch", fetchMock);

	await dispatchInvestigation({ baseUrl: "https://worker.test", token: "secret" }, "eval-917-run", {
		runId: "run-1",
		issueNumber: 917,
		mode: "diagnose",
		model: BOT_MODELS[1],
		arg: null,
		issueTitle: "Scheduled posts fail",
		issueBody: "body",
		previousBranchSha: null,
		baseRef: "main",
	});

	const request = fetchMock.mock.calls[0]?.[1];
	if (typeof request?.body !== "string") throw new Error("expected string request body");
	expect(JSON.parse(request.body)).toMatchObject({
		initialData: { model: BOT_MODELS[1] },
	});
});

describe("extractInvestigationResult", () => {
	test("finds the reported payload nested in a snapshot data part", () => {
		const snapshot = {
			messages: [
				{ role: "assistant", parts: [{ type: "text", text: "done" }] },
				{ role: "assistant", parts: [{ type: "data", name: "investigation", data: REPORTED }] },
			],
		};
		expect(extractInvestigationResult(snapshot)).toEqual(REPORTED);
	});

	test("finds the payload when it arrives as a stringified tool output", () => {
		const snapshot = { parts: [{ type: "tool-result", output: JSON.stringify(REPORTED) }] };
		expect(extractInvestigationResult(snapshot)).toEqual(REPORTED);
	});

	test("returns the last reported payload when several are present", () => {
		const first = { result: { reproduced: false, summary: "first pass" }, ok: true, pushed: false };
		const snapshot = { a: { data: first }, b: { data: REPORTED } };
		expect(extractInvestigationResult(snapshot)).toEqual(REPORTED);
	});

	test("returns null when no payload is present", () => {
		expect(extractInvestigationResult({ messages: [{ text: "still working" }] })).toBeNull();
	});

	test("ignores a partial object missing ok/pushed", () => {
		expect(extractInvestigationResult({ result: { summary: "x" } })).toBeNull();
	});
});

describe("waitForResult", () => {
	const endpoint = { baseUrl: "https://worker.test", token: "t" };

	test("resolves once the reported payload appears", async () => {
		const snapshots: Snapshot[] = [
			{ settlements: [] },
			{ settlements: [], messages: [{ data: REPORTED }] },
		];
		let call = 0;
		const result = await waitForResult(endpoint, "eval-917-x", {
			timeoutMs: 10_000,
			pollMs: 0,
			now: () => 0,
			sleep: async () => {},
			fetchSnapshot: async () => snapshots[Math.min(call++, snapshots.length - 1)]!,
		});
		expect(result).toEqual(REPORTED);
	});

	test("returns null when the run settles with no verdict", async () => {
		const result = await waitForResult(endpoint, "eval-917-x", {
			timeoutMs: 10_000,
			pollMs: 0,
			now: () => 0,
			sleep: async () => {},
			fetchSnapshot: async () => ({ settlements: [{ done: true }] }),
		});
		expect(result).toBeNull();
	});

	test("throws once the deadline passes without a verdict", async () => {
		let clock = 0;
		await expect(
			waitForResult(endpoint, "eval-917-x", {
				timeoutMs: 100,
				pollMs: 10,
				now: () => (clock += 60),
				sleep: async () => {},
				fetchSnapshot: async () => ({ settlements: [] }),
			}),
		).rejects.toThrow(/timed out/);
	});
});
