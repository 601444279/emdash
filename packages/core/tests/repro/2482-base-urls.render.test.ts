/**
 * Built-in widgets and SEO routes must respect Astro's configured `base`
 * path when building public URLs. Without this, sites deployed under a base
 * emit root-absolute links that 404 on the parent domain.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/api/public-url.js", () => ({
	getPublicOrigin: () => "https://example.com",
	getBasePath: () => "/field-notes",
}));

vi.mock("../../src/taxonomies/index.js", () => ({
	getTaxonomyTerms: vi.fn(),
}));

vi.mock("../../src/query.js", () => ({
	getEmDashCollection: vi.fn(),
}));

vi.mock("#api/handlers/seo.js", () => ({
	handleSitemapData: vi.fn(),
}));

vi.mock("#settings/index.js", () => ({
	getSiteSettingsWithDb: vi.fn(),
}));

import { handleSitemapData } from "#api/handlers/seo.js";
import { getSiteSettingsWithDb } from "#settings/index.js";

import { GET as robotsGET } from "../../src/astro/routes/robots.txt.ts";
import { GET as collectionSitemapGET } from "../../src/astro/routes/sitemap-[collection].xml.ts";
import { GET as sitemapIndexGET } from "../../src/astro/routes/sitemap.xml.ts";
import Archives from "../../src/components/widgets/Archives.astro";
import Categories from "../../src/components/widgets/Categories.astro";
import RecentPosts from "../../src/components/widgets/RecentPosts.astro";
import Search from "../../src/components/widgets/Search.astro";
import Tags from "../../src/components/widgets/Tags.astro";
import { getEmDashCollection } from "../../src/query.js";
import { getTaxonomyTerms } from "../../src/taxonomies/index.js";

const mockedTaxonomyTerms = vi.mocked(getTaxonomyTerms);
const mockedCollection = vi.mocked(getEmDashCollection);
const mockedSitemapData = vi.mocked(handleSitemapData);
const mockedSiteSettings = vi.mocked(getSiteSettingsWithDb);

async function render(component: unknown) {
	const container = await AstroContainer.create();
	return container.renderToString(component as never, { props: {} });
}

describe("built-in widgets with an Astro base", () => {
	it("Categories links include the base path", async () => {
		mockedTaxonomyTerms.mockResolvedValue([
			{ slug: "notes", label: "Notes", count: 3 },
			{ slug: "systems", label: "Systems", count: 1 },
		]);

		const html = await render(Categories);

		expect(html).toContain('href="/field-notes/category/notes"');
		expect(html).toContain('href="/field-notes/category/systems"');
	});

	it("Tags links include the base path", async () => {
		mockedTaxonomyTerms.mockResolvedValue([
			{ slug: "agents", label: "Agents", count: 2 },
			{ slug: "production", label: "Production", count: 5 },
		]);

		const html = await render(Tags);

		expect(html).toContain('href="/field-notes/tag/agents"');
		expect(html).toContain('href="/field-notes/tag/production"');
	});

	it("Search form action includes the base path", async () => {
		const html = await render(Search);

		expect(html).toContain('action="/field-notes/search"');
	});

	it("RecentPosts links include the base path", async () => {
		mockedCollection.mockResolvedValue({
			entries: [
				{ id: "post-1", data: { title: "Hello world", publishedAt: "2025-01-15T00:00:00Z" } },
			],
		});

		const html = await render(RecentPosts);

		expect(html).toContain('href="/field-notes/posts/post-1"');
	});

	it("Archives links include the base path", async () => {
		mockedCollection.mockResolvedValue({
			entries: [{ id: "post-1", data: { publishedAt: "2025-03-10T00:00:00Z" } }],
		});

		const html = await render(Archives);

		expect(html).toContain('href="/field-notes/archives/2025/03"');
	});
});

describe("SEO routes with an Astro base", () => {
	const locals = { emdash: { db: {} as never } };

	beforeEach(() => {
		mockedSiteSettings.mockResolvedValue({ url: "https://example.com/" });
	});

	it("sitemap index references child sitemaps under the base", async () => {
		mockedSitemapData.mockResolvedValue({
			success: true,
			data: {
				collections: [{ collection: "posts", lastmod: "2025-01-01T00:00:00Z" }],
			},
		});

		const response = await sitemapIndexGET({
			url: new URL("https://example.com/field-notes/sitemap.xml"),
			request: new Request("https://example.com/field-notes/sitemap.xml"),
			locals,
		} as Parameters<typeof sitemapIndexGET>[0]);

		const body = await response.text();
		expect(body).toContain("https://example.com/field-notes/sitemap-posts.xml");
	});

	it("robots.txt references the sitemap under the base", async () => {
		const response = await robotsGET({
			url: new URL("https://example.com/field-notes/robots.txt"),
			request: new Request("https://example.com/field-notes/robots.txt"),
			locals,
		} as Parameters<typeof robotsGET>[0]);

		const body = await response.text();
		expect(body).toContain("Sitemap: https://example.com/field-notes/sitemap.xml");
	});

	it("collection sitemap emits entry URLs under the base", async () => {
		mockedSitemapData.mockResolvedValue({
			success: true,
			data: {
				collections: [
					{
						collection: "posts",
						lastmod: "2025-01-01T00:00:00Z",
						urlPattern: null,
						entries: [
							{
								id: "post-1",
								slug: "hello-world",
								updatedAt: "2025-01-01T00:00:00Z",
								locale: "en",
								translationGroup: null,
								image: null,
							},
						],
					},
				],
			},
		});

		const response = await collectionSitemapGET({
			url: new URL("https://example.com/field-notes/sitemap-posts.xml"),
			request: new Request("https://example.com/field-notes/sitemap-posts.xml"),
			locals,
			params: { collection: "posts" },
		} as Parameters<typeof collectionSitemapGET>[0]);

		const body = await response.text();
		expect(body).toContain("https://example.com/field-notes/posts/hello-world");
	});
});
