import { Button, Input, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchMenus } from "../lib/api/menus.js";
import {
	assignSiteMenu,
	createSite,
	fetchSiteMenu,
	fetchRegisteredThemes,
	fetchSites,
	fetchThemeHistory,
	rollbackTheme,
	updateSite,
	type CreateManagedSiteInput,
	type ManagedSite,
	type RegisteredTheme,
} from "../lib/api/sites.js";
import { RouterLinkButton } from "./RouterLinkButton.js";

function themeOptionKey(
	theme: Pick<ManagedSite["theme"] | RegisteredTheme, "id" | "version">,
): string {
	return `${theme.id}@${theme.version}`;
}

function stringThemeSettings(settings: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(settings).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

export function Sites() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [formOpen, setFormOpen] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const [selectedSite, setSelectedSite] = React.useState<ManagedSite>();
	const [selectedThemeKey, setSelectedThemeKey] = React.useState("");
	const [selectedThemeSettings, setSelectedThemeSettings] = React.useState<Record<string, string>>(
		{},
	);
	const [selectedMenuId, setSelectedMenuId] = React.useState("");
	const [themeError, setThemeError] = React.useState<string>();
	const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: fetchSites });
	const themesQuery = useQuery({ queryKey: ["registered-themes"], queryFn: fetchRegisteredThemes });
	const themeOptions = themesQuery.data ?? [];
	const selectedTheme = themeOptions.find((theme) => themeOptionKey(theme) === selectedThemeKey);
	const historyQuery = useQuery({
		queryKey: ["site-theme-history", selectedSite?.key],
		queryFn: () => fetchThemeHistory(selectedSite?.key ?? ""),
		enabled: selectedSite !== undefined,
	});
	const menusQuery = useQuery({ queryKey: ["menus"], queryFn: () => fetchMenus() });
	const siteMenuQuery = useQuery({
		queryKey: ["site-menu", selectedSite?.key],
		queryFn: () => fetchSiteMenu(selectedSite?.key ?? ""),
		enabled: selectedSite !== undefined,
	});
	React.useEffect(() => {
		if (siteMenuQuery.data?.menuId) setSelectedMenuId(siteMenuQuery.data.menuId);
	}, [siteMenuQuery.data?.menuId]);
	const createMutation = useMutation({
		mutationFn: createSite,
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["sites"] });
			setFormOpen(false);
			setError(undefined);
		},
		onError: (cause) => setError(cause instanceof Error ? cause.message : t`Failed to create site`),
	});
	const updateThemeMutation = useMutation({
		mutationFn: ({ key, theme }: { key: string; theme: CreateManagedSiteInput["theme"] }) =>
			updateSite(key, { theme }),
		onSuccess: async (site) => {
			setSelectedSite(site);
			setSelectedThemeKey(themeOptionKey(site.theme));
			setSelectedThemeSettings(stringThemeSettings(site.theme.settings));
			setThemeError(undefined);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["sites"] }),
				queryClient.invalidateQueries({ queryKey: ["site-theme-history", site.key] }),
			]);
		},
		onError: (cause) =>
			setThemeError(cause instanceof Error ? cause.message : t`Failed to update site`),
	});
	const rollbackThemeMutation = useMutation({
		mutationFn: ({ key, historyId }: { key: string; historyId: string }) =>
			rollbackTheme(key, historyId),
		onSuccess: async (site) => {
			setSelectedSite(site);
			setSelectedThemeKey(themeOptionKey(site.theme));
			setSelectedThemeSettings(stringThemeSettings(site.theme.settings));
			setThemeError(undefined);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["sites"] }),
				queryClient.invalidateQueries({ queryKey: ["site-theme-history", site.key] }),
			]);
		},
		onError: (cause) =>
			setThemeError(cause instanceof Error ? cause.message : t`Failed to roll back theme`),
	});
	const assignMenuMutation = useMutation({
		mutationFn: ({ key, menuId }: { key: string; menuId: string }) => assignSiteMenu(key, menuId),
		onSuccess: async (_, variables) => {
			setThemeError(undefined);
			await queryClient.invalidateQueries({ queryKey: ["site-menu", variables.key] });
		},
		onError: (cause) =>
			setThemeError(cause instanceof Error ? cause.message : t`Failed to assign site menu`),
	});

	function handleCreate(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const data = new FormData(event.currentTarget);
		const theme = themeOptions.find(
			(option) => themeOptionKey(option) === String(data.get("theme") ?? ""),
		);
		if (!theme) {
			setError(t`Invalid theme`);
			return;
		}
		const input: CreateManagedSiteInput = {
			name: String(data.get("name") ?? ""),
			key: String(data.get("key") ?? ""),
			domains: String(data.get("domain") ?? "")
				.split(",")
				.map((domain) => domain.trim())
				.filter(Boolean),
			theme: {
				id: theme.id,
				version: theme.version,
				settings: theme.defaults,
			},
		};
		createMutation.mutate(input);
	}

	function openThemeManager(site: ManagedSite) {
		setSelectedSite(site);
		setSelectedThemeKey(themeOptionKey(site.theme));
		setSelectedThemeSettings(stringThemeSettings(site.theme.settings));
		setSelectedMenuId("");
		setThemeError(undefined);
	}

	function saveTheme() {
		if (!selectedSite) return;
		if (!selectedTheme) {
			setThemeError(t`Invalid theme`);
			return;
		}
		updateThemeMutation.mutate({
			key: selectedSite.key,
			theme: {
				id: selectedTheme.id,
				version: selectedTheme.version,
				settings: { ...selectedTheme.defaults, ...selectedThemeSettings },
			},
		});
	}

	function settingLabel(value: string): string {
		switch (value) {
			case "ocean":
				return t`Ocean`;
			case "slate":
				return t`Slate`;
			case "forest":
				return t`Forest`;
			case "amber":
				return t`Amber`;
			case "indigo":
				return t`Indigo`;
			case "graphite":
				return t`Graphite`;
			case "sans":
				return t`Modern sans`;
			case "serif":
				return t`Editorial serif`;
			case "flat":
				return t`Flat`;
			case "elevated":
				return t`Elevated`;
			case "bordered":
				return t`Bordered`;
			case "inline":
				return t`Inline`;
			case "centered":
				return t`Centered`;
			case "stacked":
				return t`Stacked`;
			case "compact":
				return t`Compact`;
			case "columns":
				return t`Columns`;
			default:
				return t`Default`;
		}
	}

	function settingValues(key: string): string[] {
		return selectedTheme?.settings[key] ?? [];
	}

	return (
		<div className="max-w-5xl pb-10">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold leading-tight text-balance">{t`Sites`}</h1>
					<p className="mt-2 text-sm text-kumo-subtle">
						{t`Each site has isolated content, media, domains, and theme settings.`}
					</p>
				</div>
				<Button icon={<Plus />} onClick={() => setFormOpen((open) => !open)}>
					{formOpen ? t`Close` : t`Create Site`}
				</Button>
			</header>

			{formOpen && (
				<form
					onSubmit={handleCreate}
					className="mt-6 grid gap-4 rounded-lg border border-kumo-line bg-kumo-elevated p-5 sm:grid-cols-2"
				>
					<Input label={t`Site name`} name="name" required placeholder={t`Example Publishing`} />
					<Input
						label={t`Site key`}
						name="key"
						required
						placeholder={t`example-publishing`}
						pattern="[a-z][a-z0-9\\-]{0,62}"
					/>
					<Input
						className="sm:col-span-2"
						label={t`Domains`}
						name="domain"
						placeholder={t`example.com, www.example.com`}
					/>
					<Select
						label={t`Theme`}
						name="theme"
						defaultValue={themeOptions[0] ? themeOptionKey(themeOptions[0]) : undefined}
					>
						{themeOptions.map((theme) => (
							<Select.Option key={themeOptionKey(theme)} value={themeOptionKey(theme)}>
								{theme.name} {theme.version}
							</Select.Option>
						))}
					</Select>
					<div className="flex items-end justify-end gap-3">
						<Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
							{t`Cancel`}
						</Button>
						<Button
							type="submit"
							disabled={
								createMutation.isPending || themesQuery.isLoading || themeOptions.length === 0
							}
						>
							{createMutation.isPending ? t`Creating…` : t`Create Site`}
						</Button>
					</div>
					{error && <p className="sm:col-span-2 text-sm text-kumo-danger">{error}</p>}
				</form>
			)}

			<div className="mt-6 grid gap-3">
				{sitesQuery.isLoading && <p className="text-sm text-kumo-subtle">{t`Loading sites…`}</p>}
				{sitesQuery.data?.map((site) => (
					<article
						key={site.id}
						className="rounded-lg border border-kumo-line bg-kumo-elevated p-5"
					>
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div>
								<h2 className="text-base font-semibold">{site.name}</h2>
								<p className="mt-1 font-mono text-xs text-kumo-subtle">{site.key}</p>
							</div>
							<span className="rounded-full bg-kumo-success/15 px-2.5 py-1 text-xs font-medium text-kumo-success">
								{site.status === "active" ? t`Active` : t`Archived`}
							</span>
						</div>
						<p className="mt-4 text-sm text-kumo-subtle">
							{site.domains.length > 0 ? site.domains.join(", ") : t`No domain connected yet`}
						</p>
						<p className="mt-2 text-xs text-kumo-subtle">
							{t`Theme`}: {site.theme.id} {site.theme.version}
						</p>
						<div className="mt-4 flex flex-wrap gap-2">
							<RouterLinkButton
								to="/content/$collection"
								params={{ collection: "posts" }}
								search={{ locale: undefined, site: site.key }}
								size="sm"
							>
								{t`Manage content`}
							</RouterLinkButton>
							<Button size="sm" variant="outline" onClick={() => openThemeManager(site)}>
								{t`Manage theme`}
							</Button>
						</div>
					</article>
				))}
				{sitesQuery.data?.length === 0 && !sitesQuery.isLoading && (
					<p className="rounded-lg border border-dashed border-kumo-line p-8 text-sm text-kumo-subtle">
						{t`Create your first site to begin managing its content and theme.`}
					</p>
				)}
			</div>

			{selectedSite && (
				<section className="mt-6 rounded-lg border border-kumo-line bg-kumo-elevated p-5">
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div>
							<h2 className="text-base font-semibold">{t`Theme management`}</h2>
							<p className="mt-1 text-sm text-kumo-subtle">
								{t`Choose the theme version to activate. Content is not changed.`}
							</p>
						</div>
						<Button size="sm" variant="outline" onClick={() => setSelectedSite(undefined)}>
							{t`Close`}
						</Button>
					</div>
					<div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
						<Select
							label={t`Theme version`}
							value={selectedThemeKey}
							onValueChange={(value) => {
								const nextTheme = themeOptions.find((theme) => themeOptionKey(theme) === value);
								setSelectedThemeKey(value ?? "");
								if (nextTheme) setSelectedThemeSettings(nextTheme.defaults);
							}}
						>
							{themeOptions.map((theme) => (
								<Select.Option key={themeOptionKey(theme)} value={themeOptionKey(theme)}>
									{theme.name} {theme.version}
								</Select.Option>
							))}
						</Select>
						<Button onClick={saveTheme} disabled={updateThemeMutation.isPending}>
							{updateThemeMutation.isPending ? t`Saving…` : t`Activate theme`}
						</Button>
					</div>
					<section className="mt-6">
						<h3 className="text-sm font-semibold">{t`Navigation menu`}</h3>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t`Only this site's assigned menu is shown by its public theme.`}
						</p>
						<div className="mt-4 flex flex-wrap items-end gap-3">
							<Select
								className="min-w-64"
								label={t`Menu`}
								value={selectedMenuId}
								onValueChange={(value) => setSelectedMenuId(value ?? "")}
							>
								{menusQuery.data?.map((menu) => (
									<Select.Option key={menu.id} value={menu.id}>
										{menu.label}
									</Select.Option>
								))}
							</Select>
							<Button
								disabled={!selectedMenuId || assignMenuMutation.isPending}
								onClick={() =>
									assignMenuMutation.mutate({ key: selectedSite.key, menuId: selectedMenuId })
								}
							>
								{assignMenuMutation.isPending ? t`Saving…` : t`Save menu`}
							</Button>
						</div>
						{menusQuery.data?.length === 0 && (
							<p className="mt-2 text-sm text-kumo-subtle">{t`Create a menu before assigning it to this site.`}</p>
						)}
					</section>
					<section className="mt-6">
						<h3 className="text-sm font-semibold">{t`Style settings`}</h3>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t`These settings change the presentation only. They never modify your content.`}
						</p>
						<div className="mt-4 grid gap-4 sm:grid-cols-2">
							<Select
								label={t`Color palette`}
								value={selectedThemeSettings.palette ?? selectedTheme?.defaults.palette ?? ""}
								onValueChange={(palette) =>
									setSelectedThemeSettings((settings) => ({
										...settings,
										palette: palette ?? selectedTheme?.defaults.palette ?? "",
									}))
								}
							>
								{settingValues("palette").map((value) => (
									<Select.Option key={value} value={value}>
										{settingLabel(value)}
									</Select.Option>
								))}
							</Select>
							<Select
								label={t`Font pairing`}
								value={selectedThemeSettings.font ?? selectedTheme?.defaults.font ?? ""}
								onValueChange={(font) =>
									setSelectedThemeSettings((settings) => ({
										...settings,
										font: font ?? selectedTheme?.defaults.font ?? "",
									}))
								}
							>
								{settingValues("font").map((value) => (
									<Select.Option key={value} value={value}>
										{settingLabel(value)}
									</Select.Option>
								))}
							</Select>
							<Select
								label={t`Article cards`}
								value={selectedThemeSettings.cardStyle ?? selectedTheme?.defaults.cardStyle ?? ""}
								onValueChange={(cardStyle) =>
									setSelectedThemeSettings((settings) => ({
										...settings,
										cardStyle: cardStyle ?? selectedTheme?.defaults.cardStyle ?? "",
									}))
								}
							>
								{settingValues("cardStyle").map((value) => (
									<Select.Option key={value} value={value}>
										{settingLabel(value)}
									</Select.Option>
								))}
							</Select>
							<Select
								label={t`Navigation layout`}
								value={selectedThemeSettings.navigation ?? selectedTheme?.defaults.navigation ?? ""}
								onValueChange={(navigation) =>
									setSelectedThemeSettings((settings) => ({
										...settings,
										navigation: navigation ?? selectedTheme?.defaults.navigation ?? "",
									}))
								}
							>
								{settingValues("navigation").map((value) => (
									<Select.Option key={value} value={value}>
										{settingLabel(value)}
									</Select.Option>
								))}
							</Select>
							<Select
								label={t`Footer layout`}
								value={selectedThemeSettings.footer ?? selectedTheme?.defaults.footer ?? ""}
								onValueChange={(footer) =>
									setSelectedThemeSettings((settings) => ({
										...settings,
										footer: footer ?? selectedTheme?.defaults.footer ?? "",
									}))
								}
							>
								{settingValues("footer").map((value) => (
									<Select.Option key={value} value={value}>
										{settingLabel(value)}
									</Select.Option>
								))}
							</Select>
						</div>
					</section>
					{themeError && <p className="mt-3 text-sm text-kumo-danger">{themeError}</p>}
					<div className="mt-6">
						<h3 className="text-sm font-semibold">{t`Theme history`}</h3>
						{historyQuery.isLoading && (
							<p className="mt-2 text-sm text-kumo-subtle">{t`Loading theme history…`}</p>
						)}
						{historyQuery.data?.length === 0 && (
							<p className="mt-2 text-sm text-kumo-subtle">{t`No previous theme versions.`}</p>
						)}
						<ul className="mt-3 grid gap-2">
							{historyQuery.data?.map((entry) => (
								<li
									key={entry.id}
									className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-kumo-line p-3 text-sm"
								>
									<span>
										{entry.theme.id} {entry.theme.version}
									</span>
									<Button
										size="sm"
										variant="outline"
										disabled={rollbackThemeMutation.isPending}
										onClick={() =>
											rollbackThemeMutation.mutate({ key: selectedSite.key, historyId: entry.id })
										}
									>
										{rollbackThemeMutation.isPending ? t`Restoring…` : t`Restore`}
									</Button>
								</li>
							))}
						</ul>
					</div>
				</section>
			)}
		</div>
	);
}
