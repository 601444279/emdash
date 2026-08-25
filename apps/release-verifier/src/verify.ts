import {
	MAX_BUNDLE_COMPRESSED_BYTES,
	fetchVerifiedResource,
	validatePluginBundle,
	verifyMultihash,
	type FetchImplementation,
	type HostnameResolver,
	type ValidatedPluginBundle,
	type VerificationErrorCode,
} from "@emdash-cms/registry-verification";

import { resolvePublicHostname } from "./dns.js";

const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const CHECKSUM_PATTERN = /^b[a-z2-7]+$/;

export interface VerifyArtifactInput {
	url: string;
	checksum: string;
	packageSlug: string;
	version: string;
}

export interface VerifiedArtifactReport {
	url: string;
	checksum: string;
	compressedBytes: number;
	manifest: {
		id: string;
		version: string;
		declaredAccess: ValidatedPluginBundle["declaredAccess"];
	};
	bundle: {
		backendBytes: number;
		adminBytes: number | null;
	};
}

export type ArtifactVerificationReport =
	| { success: true; value: VerifiedArtifactReport }
	| {
			success: false;
			error: {
				code: VerificationErrorCode | "VERIFIER_INPUT_INVALID" | "VERIFIER_INTERNAL_ERROR";
				message: string;
			};
	  };

export interface VerifierDependencies {
	fetch: FetchImplementation;
	resolveHostname: HostnameResolver;
}

function validInput(input: VerifyArtifactInput): boolean {
	return (
		input !== null &&
		typeof input === "object" &&
		Object.keys(input).length === 4 &&
		typeof input.url === "string" &&
		input.url.length <= 2048 &&
		typeof input.checksum === "string" &&
		CHECKSUM_PATTERN.test(input.checksum) &&
		PACKAGE_SLUG_PATTERN.test(input.packageSlug) &&
		VERSION_PATTERN.test(input.version)
	);
}

export async function verifyArtifact(
	input: VerifyArtifactInput,
	dependencies: VerifierDependencies = {
		fetch: (url, init) => fetch(url, init),
		resolveHostname: resolvePublicHostname,
	},
): Promise<ArtifactVerificationReport> {
	if (!validInput(input)) {
		return {
			success: false,
			error: { code: "VERIFIER_INPUT_INVALID", message: "Artifact request is invalid" },
		};
	}
	try {
		const resource = await fetchVerifiedResource(input.url, {
			...dependencies,
			maxBytes: MAX_BUNDLE_COMPRESSED_BYTES,
		});
		if (!resource.success) return resource;
		const checksum = await verifyMultihash(resource.value.bytes, input.checksum);
		if (!checksum.success) return checksum;
		const bundle = await validatePluginBundle(resource.value.bytes, {
			expectedSlug: input.packageSlug,
			expectedVersion: input.version,
		});
		if (!bundle.success) return bundle;
		return {
			success: true,
			value: {
				url: resource.value.url.toString(),
				checksum: input.checksum,
				compressedBytes: resource.value.bytes.byteLength,
				manifest: {
					id: bundle.value.manifest.id,
					version: bundle.value.manifest.version,
					declaredAccess: bundle.value.declaredAccess,
				},
				bundle: {
					backendBytes: bundle.value.backend.byteLength,
					adminBytes: bundle.value.admin?.byteLength ?? null,
				},
			},
		};
	} catch {
		return {
			success: false,
			error: { code: "VERIFIER_INTERNAL_ERROR", message: "Artifact verification failed" },
		};
	}
}
