import { beforeEach, expect, it, vi } from "vitest";

const scheduled = vi.hoisted(() => ({
	general: vi.fn(async () => ({ published: [] })),
	mediaUsage: vi.fn(async () => ({ outcome: "inactive", taskClass: null, turn: null })),
}));

vi.mock("@astrojs/cloudflare/entrypoints/server", () => ({ default: { fetch: vi.fn() } }));
vi.mock("astro/app/entrypoint", () => ({
	createApp: () => ({ pipeline: { getCacheProvider: async () => null } }),
}));
vi.mock("emdash/middleware", () => ({
	runScheduledTasks: scheduled.general,
	runScheduledMediaUsageTasks: scheduled.mediaUsage,
}));
vi.mock("../src/sandbox/index.js", () => ({ PluginBridge: vi.fn() }));

import { createScheduledHandler } from "../src/worker.js";

beforeEach(() => {
	scheduled.general.mockClear();
	scheduled.mediaUsage.mockClear();
});

it("keeps the unconfigured handler backwards-compatible", async () => {
	await invoke(createScheduledHandler(), "custom expression");
	expect(scheduled.general).toHaveBeenCalledOnce();
	expect(scheduled.mediaUsage).toHaveBeenCalledOnce();
});

it("dispatches distinct configured cron expressions to exactly one lane", async () => {
	const handler = createScheduledHandler({
		generalCron: "* * * * *",
		mediaUsageCron: "*/2 * * * *",
	});

	await invoke(handler, "* * * * *");
	expect(scheduled.general).toHaveBeenCalledOnce();
	expect(scheduled.mediaUsage).not.toHaveBeenCalled();

	scheduled.general.mockClear();
	await invoke(handler, "*/2 * * * *");
	expect(scheduled.general).not.toHaveBeenCalled();
	expect(scheduled.mediaUsage).toHaveBeenCalledOnce();

	scheduled.mediaUsage.mockClear();
	await invoke(handler, "0 0 * * *");
	expect(scheduled.general).not.toHaveBeenCalled();
	expect(scheduled.mediaUsage).not.toHaveBeenCalled();
});

it("rejects empty or aliased configured expressions", () => {
	expect(() =>
		createScheduledHandler({ generalCron: "* * * * *", mediaUsageCron: "* * * * *" }),
	).toThrow(/must differ/i);
	expect(() => createScheduledHandler({ generalCron: "", mediaUsageCron: "*/2 * * * *" })).toThrow(
		/non-empty/i,
	);
});

async function invoke(handler: ExportedHandlerScheduledHandler, cron: string): Promise<void> {
	const pending: Promise<unknown>[] = [];
	const context = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise);
		},
	};
	Reflect.apply(handler, undefined, [{ cron }, {}, context]);
	await Promise.all(pending);
}
