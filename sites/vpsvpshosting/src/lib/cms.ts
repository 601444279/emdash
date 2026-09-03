import type { Theme, ThemePost, ThemeSite } from "@emdash-cms/astro-themes/types";

export type { Theme };
export type Site = ThemeSite;
export type Post = ThemePost;

interface ApiSuccess<T> {
	success: true;
	data: T;
}

export async function getSite(): Promise<Site> {
	return getJson<Site>(`/_emdash/api/public/sites/${siteKey()}`);
}

export async function getPosts(limit = 20): Promise<Post[]> {
	return getEntries("posts", limit);
}

export async function getPost(slug: string): Promise<Post | null> {
	return getEntry("posts", slug);
}

export async function getEntries(collection: string, limit = 20): Promise<Post[]> {
	const result = await getJson<{ items: Post[] }>(
		`/_emdash/api/public/sites/${siteKey()}/content/${encodeURIComponent(collection)}?limit=${limit}`,
	);
	return result.items;
}

export async function getEntry(collection: string, slug: string): Promise<Post | null> {
	try {
		const result = await getJson<{ item: Post }>(
			`/_emdash/api/public/sites/${siteKey()}/content/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`,
		);
		return result.item;
	} catch {
		return null;
	}
}

function siteKey(): string {
	return import.meta.env.CMS_SITE_KEY || "vpsvpshosting";
}

async function getJson<T>(path: string): Promise<T> {
	const baseUrl = import.meta.env.CMS_BASE_URL;
	if (!baseUrl) throw new Error("CMS_BASE_URL is not configured");
	const response = await fetch(new URL(path, baseUrl));
	if (!response.ok) throw new Error(`CMS request failed with ${response.status}`);
	const body = (await response.json()) as ApiSuccess<T>;
	if (!body.success) throw new Error("CMS response was unsuccessful");
	return body.data;
}
