import { describe, expect, it } from "vitest";

import { getTheme, listThemes, validateThemeSettings } from "../../src/themes/index.js";

describe("site theme registry", () => {
	it("contains two versioned built-in themes", () => {
		expect([...new Set(listThemes().map((theme) => theme.id))]).toEqual(["editorial", "catalog"]);
		expect(getTheme("editorial", "1.0.0")?.pages).toContain("category");
		expect(getTheme("catalog", "1.1.0")?.pages).toContain("search");
	});

	it("accepts declared settings and rejects arbitrary CSS", () => {
		expect(
			validateThemeSettings("editorial", "1.0.0", { palette: "ocean", cardStyle: "elevated" }),
		).toEqual({
			palette: "ocean",
			font: "sans",
			cardStyle: "elevated",
			navigation: "inline",
			footer: "columns",
		});
		expect(() => validateThemeSettings("editorial", "1.0.0", { customCss: "body {}" })).toThrow(
			"INVALID_THEME_SETTINGS",
		);
	});
});
