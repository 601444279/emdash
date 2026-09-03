import { describe, expect, it } from "vitest";

import { getTheme, listThemes, validateThemeSettings } from "../../src/themes/index.js";

describe("site theme registry", () => {
	it("contains versioned built-in themes", () => {
		expect([...new Set(listThemes().map((theme) => theme.id))]).toEqual(["catalog", "ranked"]);
		expect(getTheme("catalog", "1.1.0")?.pages).toContain("search");
		expect(getTheme("ranked", "1.0.0")?.pages).toContain("post");
	});

	it("accepts declared settings and rejects arbitrary CSS", () => {
		expect(() => validateThemeSettings("ranked", "1.0.0", { customCss: "body {}" })).toThrow(
			"INVALID_THEME_SETTINGS",
		);
		expect(validateThemeSettings("ranked", "1.0.0", { palette: "forest" })).toEqual({
			palette: "forest",
			font: "serif",
			cardStyle: "elevated",
			navigation: "inline",
			footer: "columns",
		});
	});
});
