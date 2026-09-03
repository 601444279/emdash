export type ThemePage = "home" | "post" | "category" | "search" | "archive" | "page";

export interface ThemeDefinition {
	id: string;
	version: string;
	name: string;
	pages: readonly ThemePage[];
	settings: Readonly<Record<string, readonly string[]>>;
	defaults: Readonly<Record<string, string>>;
}

const THEMES: readonly ThemeDefinition[] = [
	{
		id: "editorial",
		version: "1.0.0",
		name: "Editorial",
		pages: ["home", "post", "category", "search", "archive", "page"],
		settings: {
			palette: ["ocean", "slate", "forest"],
			font: ["sans", "serif"],
			cardStyle: ["flat", "elevated"],
			navigation: ["inline", "centered"],
			footer: ["compact", "columns"],
		},
		defaults: {
			palette: "ocean",
			font: "sans",
			cardStyle: "elevated",
			navigation: "inline",
			footer: "columns",
		},
	},
	{
		id: "editorial",
		version: "1.1.0",
		name: "Editorial",
		pages: ["home", "post", "category", "search", "archive", "page"],
		settings: {
			palette: ["ocean", "slate", "forest"],
			font: ["sans", "serif"],
			cardStyle: ["flat", "elevated"],
			navigation: ["inline", "centered"],
			footer: ["compact", "columns"],
		},
		defaults: {
			palette: "ocean",
			font: "sans",
			cardStyle: "elevated",
			navigation: "inline",
			footer: "columns",
		},
	},
	{
		id: "catalog",
		version: "1.0.0",
		name: "Catalog",
		pages: ["home", "post", "category", "search", "archive", "page"],
		settings: {
			palette: ["amber", "indigo", "graphite"],
			font: ["sans", "serif"],
			cardStyle: ["flat", "bordered"],
			navigation: ["inline", "stacked"],
			footer: ["compact", "columns"],
		},
		defaults: {
			palette: "indigo",
			font: "sans",
			cardStyle: "bordered",
			navigation: "inline",
			footer: "columns",
		},
	},
	{
		id: "catalog",
		version: "1.1.0",
		name: "Catalog",
		pages: ["home", "post", "category", "search", "archive", "page"],
		settings: {
			palette: ["amber", "indigo", "graphite"],
			font: ["sans", "serif"],
			cardStyle: ["flat", "bordered"],
			navigation: ["inline", "stacked"],
			footer: ["compact", "columns"],
		},
		defaults: {
			palette: "indigo",
			font: "sans",
			cardStyle: "bordered",
			navigation: "inline",
			footer: "columns",
		},
	},
];

export function listThemes(): readonly ThemeDefinition[] {
	return THEMES;
}

export function getTheme(id: string, version: string): ThemeDefinition | null {
	return THEMES.find((theme) => theme.id === id && theme.version === version) ?? null;
}

export function validateThemeSettings(
	themeId: string,
	version: string,
	settings: Record<string, unknown>,
): Record<string, string> {
	const theme = getTheme(themeId, version);
	if (!theme) throw new Error("THEME_NOT_FOUND");

	const validated: Record<string, string> = { ...theme.defaults };
	for (const [key, value] of Object.entries(settings)) {
		const allowedValues = theme.settings[key];
		if (typeof value !== "string" || !allowedValues?.includes(value)) {
			throw new Error("INVALID_THEME_SETTINGS");
		}
		validated[key] = value;
	}
	return validated;
}
