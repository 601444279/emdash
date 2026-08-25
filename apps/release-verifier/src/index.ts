import { WorkerEntrypoint } from "cloudflare:workers";

import {
	verifyArtifact,
	type ArtifactVerificationReport,
	type VerifyArtifactInput,
} from "./verify.js";

export default class ReleaseVerifier extends WorkerEntrypoint<Env> {
	async verifyArtifact(input: VerifyArtifactInput): Promise<ArtifactVerificationReport> {
		return verifyArtifact(input);
	}
}
