interface ImportMetaEnv {
	readonly CMS_BASE_URL?: string;
	readonly CMS_SITE_KEY?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
