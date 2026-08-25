import type {
	DirectPdsDidDocumentResolver,
	DirectPdsProfileRecord,
	DirectPdsReadErrorCode,
	DirectPdsReleaseRecord,
} from "@emdash-cms/registry-client/direct-pds";
import { DirectPdsClient, DirectPdsReadError } from "@emdash-cms/registry-client/direct-pds";
import {
	verifyPackageReleaseRecords,
	type ProvenanceEvidence,
	type RecordVerificationReport,
	type VerificationErrorCode,
} from "@emdash-cms/registry-verification";

import { ssrfSafeFetch } from "../security/ssrf.js";

export type AuthoritativeRecordErrorCode =
	| DirectPdsReadErrorCode
	| VerificationErrorCode
	| "AUTHORITATIVE_RECORD_READ_FAILED";

export interface AuthoritativeRecordReadOptions {
	fetch?: typeof fetch;
	didDocumentResolver?: DirectPdsDidDocumentResolver;
	provenance?: ProvenanceEvidence;
}

export interface VerifiedAuthoritativeRecords {
	profile: DirectPdsProfileRecord;
	release: DirectPdsReleaseRecord;
	report: Extract<RecordVerificationReport, { success: true }>;
}

export type AuthoritativeRecordReadResult =
	| { success: true; value: VerifiedAuthoritativeRecords }
	| {
			success: false;
			error: { code: AuthoritativeRecordErrorCode; message: string };
	  };

export type AuthoritativeRecordReader = (
	publisherDid: string,
	packageSlug: string,
	version: string,
	options?: AuthoritativeRecordReadOptions,
) => Promise<AuthoritativeRecordReadResult>;

export async function readAuthoritativePackageRelease(
	publisherDid: string,
	packageSlug: string,
	version: string,
	options: AuthoritativeRecordReadOptions = {},
): Promise<AuthoritativeRecordReadResult> {
	try {
		const client = new DirectPdsClient({
			did: publisherDid,
			fetch: options.fetch ?? guardedFetch,
			didDocumentResolver: options.didDocumentResolver,
		});
		const [profile, release] = await Promise.all([
			client.getPackageProfile(packageSlug),
			client.getPackageRelease(packageSlug, version),
		]);
		const report = await verifyPackageReleaseRecords({
			publisherDid,
			package: packageSlug,
			version,
			rkey: release.rkey,
			profile: profile.value,
			release: release.value,
			provenance: options.provenance,
		});
		if (!report.success) {
			return {
				success: false,
				error: {
					code: report.code,
					message: report.reasons[0]?.message ?? "The signed package records are invalid.",
				},
			};
		}
		return { success: true, value: { profile, release, report } };
	} catch (error) {
		if (error instanceof DirectPdsReadError) {
			return { success: false, error: { code: error.code, message: error.message } };
		}
		return {
			success: false,
			error: {
				code: "AUTHORITATIVE_RECORD_READ_FAILED",
				message: "The publisher's signed package records could not be verified.",
			},
		};
	}
}

const guardedFetch: typeof fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	return ssrfSafeFetch(url, init, { httpsOnly: true });
};
