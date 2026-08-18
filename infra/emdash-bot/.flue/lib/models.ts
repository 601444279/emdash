export const BOT_MODELS = [
	"cloudflare/@cf/moonshotai/kimi-k2.7-code",
	"cloudflare/@cf/deepseek-ai/deepseek-v4-flash-0731",
	"cloudflare/@cf/deepseek-ai/deepseek-v4-pro-0813",
] as const;

export type BotModel = (typeof BOT_MODELS)[number];

export const DEFAULT_BOT_MODEL: BotModel = BOT_MODELS[0];

export function parseBotModel(value: string): BotModel | null {
	return BOT_MODELS.find((model) => model === value) ?? null;
}

export function botModelSlug(model: BotModel): string {
	return model.slice(model.lastIndexOf("/") + 1);
}
