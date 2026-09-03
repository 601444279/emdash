import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

export interface ManagedSite {
	id: string;
	key: string;
	name: string;
	status: "active" | "archived";
	domains: string[];
	theme: {
		id: string;
		version: string;
		settings: Record<string, unknown>;
	};
}

export interface CreateManagedSiteInput {
	key: string;
	name: string;
	domains: string[];
	theme: {
		id: string;
		version: string;
		settings: Record<string, unknown>;
	};
}

export interface UpdateManagedSiteInput {
	theme?: CreateManagedSiteInput["theme"];
}

export interface ThemeHistoryEntry {
	id: string;
	theme: ManagedSite["theme"];
	createdAt: string;
}

export interface RegisteredTheme {
	id: string;
	version: string;
	name: string;
	pages: string[];
	settings: Record<string, string[]>;
	defaults: Record<string, string>;
}

export async function fetchRegisteredThemes(): Promise<RegisteredTheme[]> {
	const response = await apiFetch(`${API_BASE}/themes`);
	return parseApiResponse<RegisteredTheme[]>(response, i18n._(msg`Failed to fetch themes`));
}

export async function fetchSites(): Promise<ManagedSite[]> {
	const response = await apiFetch(`${API_BASE}/sites`);
	return parseApiResponse<ManagedSite[]>(response, i18n._(msg`Failed to fetch sites`));
}

export async function createSite(input: CreateManagedSiteInput): Promise<ManagedSite> {
	const response = await apiFetch(`${API_BASE}/sites`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<ManagedSite>(response, i18n._(msg`Failed to create site`));
}

export async function updateSite(key: string, input: UpdateManagedSiteInput): Promise<ManagedSite> {
	const response = await apiFetch(`${API_BASE}/sites/${encodeURIComponent(key)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<ManagedSite>(response, i18n._(msg`Failed to update site`));
}

export async function fetchThemeHistory(key: string): Promise<ThemeHistoryEntry[]> {
	const response = await apiFetch(`${API_BASE}/sites/${encodeURIComponent(key)}/theme-history`);
	const data = await parseApiResponse<{ items: ThemeHistoryEntry[] }>(
		response,
		i18n._(msg`Failed to fetch theme history`),
	);
	return data.items;
}

export async function rollbackTheme(key: string, historyId: string): Promise<ManagedSite> {
	const response = await apiFetch(
		`${API_BASE}/sites/${encodeURIComponent(key)}/theme-history/${encodeURIComponent(historyId)}/rollback`,
		{ method: "POST" },
	);
	return parseApiResponse<ManagedSite>(response, i18n._(msg`Failed to roll back theme`));
}
