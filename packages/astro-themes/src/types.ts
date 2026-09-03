export interface Theme {
	id: string;
	version: string;
	settings: Record<string, string>;
}

export interface ThemeSite {
	key: string;
	name: string;
	theme: Theme;
}

export interface ThemePost {
	id: string;
	slug: string;
	status: string;
	data: Record<string, unknown>;
	publishedAt: string | null;
}
