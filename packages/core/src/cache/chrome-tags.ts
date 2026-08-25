/**
 * Cache tag helpers for EmDash chrome subsystems.
 *
 * Chrome (settings, menus, taxonomies, widget areas) is rendered on every
 * page, so stale edges hurt the whole site. These stable tags let public read
 * helpers emit `cacheHint`s and admin write routes purge the matching edge
 * cache entries when chrome changes.
 */

import type { CacheHint } from "../query.js";

export const CHROME_SETTINGS_TAG = "emdash:settings";

export function chromeMenuTag(name: string): string {
	return `emdash:menu:${name}`;
}

export function chromeTaxonomyTag(name: string): string {
	return `emdash:taxonomy:${name}`;
}

export function chromeWidgetAreaTag(name: string): string {
	return `emdash:widget-area:${name}`;
}

export function chromeSettingsCacheHint(): CacheHint {
	return { tags: [CHROME_SETTINGS_TAG] };
}

export function chromeMenuCacheHint(name: string): CacheHint {
	return { tags: [chromeMenuTag(name)] };
}

export function chromeTaxonomyCacheHint(name: string): CacheHint {
	return { tags: [chromeTaxonomyTag(name)] };
}

export function chromeWidgetAreaCacheHint(name: string): CacheHint {
	return { tags: [chromeWidgetAreaTag(name)] };
}
