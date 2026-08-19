/**
 * Cloudflare Sandbox Runner - RUNTIME ENTRY
 *
 * This module is loaded at runtime when plugins need to be sandboxed.
 * It imports cloudflare:workers and should NOT be imported at config time.
 *
 * For config-time usage, import { sandbox } from "@emdash-cms/cloudflare" instead.
 *
 */

export { CloudflareSandboxRunner, createSandboxRunner } from "./runner.js";
export {
	PluginBridge,
	setEmailSendCallback,
	type PluginBridgeEnv,
	type PluginBridgeProps,
} from "./bridge.js";
export { generatePluginWrapper } from "./wrapper.js";
