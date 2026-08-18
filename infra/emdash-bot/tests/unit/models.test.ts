import { describe, expect, test } from "vitest";

import {
	BOT_MODELS,
	DEFAULT_BOT_MODEL,
	botModelSlug,
	parseBotModel,
} from "../../.flue/lib/models.js";

describe("bot models", () => {
	test("keeps Kimi as the production default and allow-lists eval alternatives", () => {
		expect(DEFAULT_BOT_MODEL).toBe("cloudflare/@cf/moonshotai/kimi-k2.7-code");
		expect(BOT_MODELS).toEqual([
			"cloudflare/@cf/moonshotai/kimi-k2.7-code",
			"cloudflare/@cf/deepseek-ai/deepseek-v4-flash-0731",
			"cloudflare/@cf/deepseek-ai/deepseek-v4-pro-0813",
		]);
	});

	test("parses only allow-listed models and produces stable artifact slugs", () => {
		expect(parseBotModel(BOT_MODELS[1])).toBe(BOT_MODELS[1]);
		expect(parseBotModel("cloudflare/unknown")).toBeNull();
		expect(botModelSlug(BOT_MODELS[0])).toBe("kimi-k2.7-code");
		expect(botModelSlug(BOT_MODELS[1])).toBe("deepseek-v4-flash-0731");
	});
});
