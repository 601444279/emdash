import handler, {
	createMediaUsageQueueHandler,
	createMediaUsageFetchHandler,
	createScheduledHandler,
	type MediaUsageWakeMessage,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

const resolveMediaUsageQueue = (env: Env) => env.MEDIA_USAGE_QUEUE;

export default {
	...handler,
	fetch: createMediaUsageFetchHandler(handler, resolveMediaUsageQueue),
	scheduled: createScheduledHandler({ resolveMediaUsageQueue }),
	queue: createMediaUsageQueueHandler(resolveMediaUsageQueue),
} satisfies ExportedHandler<Env, MediaUsageWakeMessage>;
