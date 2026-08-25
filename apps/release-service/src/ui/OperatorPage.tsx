import { Badge, Button, Input, Surface } from "@cloudflare/kumo";
import {
	ReleaseServiceOperatorClient,
	createReleaseIdempotencyKey,
	type EncryptionRotationResult,
	type OperatorPublisherResource,
	type PublisherArchivePageResult,
	type ServiceControlState,
} from "@emdash-cms/registry-client/release-service";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { ErrorBanner, LoadingPanel } from "./components.js";
import { useT } from "./i18n.js";

function operatorStatus(t: ReturnType<typeof useT>, status: string): string {
	if (status === "active") return t("operator.status.active", "Active");
	if (status === "admission-paused")
		return t("operator.status.admissionPaused", "Admission paused");
	if (status === "publication-paused")
		return t("operator.status.publicationPaused", "Publication paused");
	if (status === "allowed") return t("operator.status.allowed", "Allowed");
	if (status === "suspended") return t("operator.status.suspended", "Suspended");
	if (status === "revoked") return t("operator.status.revoked", "Revoked");
	if (status === "reauthorization_required")
		return t("operator.status.reauthorize", "Reauthorization required");
	return t("operator.status.unknown", "Unknown");
}

function archiveKindLabel(
	t: ReturnType<typeof useT>,
	kind: PublisherArchivePageResult["kind"],
): string {
	if (kind === "metadata") return t("operator.archive.kind.metadata", "metadata");
	if (kind === "workload-policies")
		return t("operator.archive.kind.workloads", "workload policies");
	if (kind === "intents") return t("operator.archive.kind.intents", "release intents");
	return t("operator.archive.kind.audit", "audit events");
}

export function OperatorPage() {
	const t = useT();
	const client = useMemo(
		() => new ReleaseServiceOperatorClient({ serviceUrl: location.origin }),
		[],
	);
	const [state, setState] = useState<ServiceControlState | null>(null);
	const [publisher, setPublisher] = useState<OperatorPublisherResource | null>(null);
	const [publisherDid, setPublisherDid] = useState("");
	const [approverDid, setApproverDid] = useState("");
	const [intentId, setIntentId] = useState("");
	const [publisherRotationCursor, setPublisherRotationCursor] = useState("");
	const [approverRotationCursor, setApproverRotationCursor] = useState("");
	const [rotation, setRotation] = useState<EncryptionRotationResult | null>(null);
	const [archiveId, setArchiveId] = useState(() => `archive-${crypto.randomUUID()}`);
	const [archiveCursor, setArchiveCursor] = useState("");
	const [archivePage, setArchivePage] = useState("0");
	const [archive, setArchive] = useState<PublisherArchivePageResult | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);

	const refreshStatus = useCallback(async () => {
		try {
			setState(await client.getStatus());
		} catch (cause) {
			setError(cause);
		}
	}, [client]);

	useEffect(() => {
		void refreshStatus();
	}, [refreshStatus]);

	async function setMode(mode: ServiceControlState["mode"]) {
		setBusy(true);
		setError(null);
		try {
			const result = await client.setMode(mode, mode === "active" ? null : "OPERATOR_PAUSE", {
				idempotencyKey: createReleaseIdempotencyKey("web-service-mode"),
			});
			setState(result.value);
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function lookupPublisher(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			setPublisher(await client.getPublisher(publisherDid));
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function setSuspended(suspended: boolean) {
		setBusy(true);
		setError(null);
		try {
			await client.setPublisherSuspended(
				publisherDid,
				suspended,
				suspended ? "OPERATOR_SUSPENDED" : null,
				{ idempotencyKey: createReleaseIdempotencyKey("web-publisher-control") },
			);
			setPublisher(await client.getPublisher(publisherDid));
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function revokePublisher() {
		setBusy(true);
		setError(null);
		try {
			await client.revokePublisher(publisherDid, {
				idempotencyKey: createReleaseIdempotencyKey("web-operator-revoke"),
			});
			setPublisher(await client.getPublisher(publisherDid));
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function rotateEncryption(owner: "approver" | "publisher") {
		setBusy(true);
		setError(null);
		try {
			const result =
				owner === "publisher"
					? await client.rotatePublisherEncryption(
							publisherDid,
							{ afterCursor: publisherRotationCursor || null, limit: 50 },
							{ idempotencyKey: createReleaseIdempotencyKey("web-publisher-rotation") },
						)
					: await client.rotateApproverEncryption(
							approverDid,
							{ afterCursor: approverRotationCursor || null, limit: 50 },
							{ idempotencyKey: createReleaseIdempotencyKey("web-approver-rotation") },
						);
			setRotation(result);
			if (owner === "publisher") setPublisherRotationCursor(result.nextCursor ?? "");
			else setApproverRotationCursor(result.nextCursor ?? "");
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function archivePublisher() {
		setBusy(true);
		setError(null);
		try {
			const result = await client.archivePublisher(
				publisherDid,
				{ archiveId, cursor: archiveCursor || null, page: Number(archivePage) },
				{ idempotencyKey: createReleaseIdempotencyKey("web-publisher-archive") },
			);
			setArchive(result);
			setArchiveCursor(result.nextCursor ?? "");
			setArchivePage(String(result.nextPage));
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	async function operateIntent(action: "cancel" | "reconcile") {
		setBusy(true);
		setError(null);
		try {
			if (action === "cancel") {
				await client.cancelIntent(publisherDid, intentId, {
					idempotencyKey: createReleaseIdempotencyKey("web-operator-cancel"),
				});
			} else {
				await client.reconcileIntent(publisherDid, intentId, {
					idempotencyKey: createReleaseIdempotencyKey("web-operator-reconcile"),
				});
			}
		} catch (cause) {
			setError(cause);
		} finally {
			setBusy(false);
		}
	}

	if (!state && !error) return <LoadingPanel />;

	return (
		<div className="flex flex-col gap-6">
			{error ? <ErrorBanner error={error} /> : null}
			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("operator.service.title", "Service control")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t(
								"operator.service.description",
								"Pause admission or publication across the hosted service.",
							)}
						</p>
					</div>
					<Badge variant={state?.mode === "active" ? "success" : "warning"}>
						{operatorStatus(t, state?.mode ?? "unknown")}
					</Badge>
				</div>
				<div className="mt-5 flex flex-wrap gap-2">
					<Button loading={busy} onClick={() => setMode("active")} variant="secondary">
						{t("operator.service.activate", "Activate")}
					</Button>
					<Button loading={busy} onClick={() => setMode("admission-paused")} variant="outline">
						{t("operator.service.pauseAdmission", "Pause admission")}
					</Button>
					<Button loading={busy} onClick={() => setMode("publication-paused")} variant="outline">
						{t("operator.service.pausePublication", "Pause publication")}
					</Button>
				</div>
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("operator.archive.title", "Publisher archive")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t(
								"operator.archive.description",
								"Write one encrypted snapshot page and resume until the completion manifest is stored.",
							)}
						</p>
					</div>
					{archive ? (
						<Badge variant={archive.complete ? "success" : "warning"}>
							{archive.complete
								? t("operator.archive.complete", "Archive complete")
								: t("operator.archive.incomplete", "Resume required")}
						</Badge>
					) : null}
				</div>
				<div className="mt-5 grid gap-4 md:grid-cols-2">
					<Input
						label={t("operator.archive.publisherDid", "Publisher DID")}
						value={publisherDid}
						onChange={(event) => setPublisherDid(event.currentTarget.value)}
					/>
					<Input
						label={t("operator.archive.id", "Archive ID")}
						value={archiveId}
						onChange={(event) => setArchiveId(event.currentTarget.value)}
					/>
					<Input
						label={t("operator.archive.cursor", "Resume cursor")}
						value={archiveCursor}
						onChange={(event) => setArchiveCursor(event.currentTarget.value)}
					/>
					<Input
						label={t("operator.archive.page", "Page number")}
						type="number"
						value={archivePage}
						onChange={(event) => setArchivePage(event.currentTarget.value)}
					/>
				</div>
				<div className="mt-4 flex flex-wrap items-center gap-3">
					<Button
						disabled={!publisherDid || !archiveId || !Number.isSafeInteger(Number(archivePage))}
						loading={busy}
						onClick={archivePublisher}
						variant="outline"
					>
						{t("operator.archive.write", "Write archive page")}
					</Button>
					{archive ? (
						<p className="text-sm text-kumo-subtle">
							{t("operator.archive.result", "Stored {kind} page {page}.", {
								kind: archiveKindLabel(t, archive.kind),
								page: archive.page,
							})}
						</p>
					) : null}
				</div>
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<h2 className="text-xl font-semibold text-kumo-strong">
							{t("operator.encryption.title", "Encryption maintenance")}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							{t(
								"operator.encryption.description",
								"Rotate one bounded shard page, then resume from the returned cursor until verification completes.",
							)}
						</p>
					</div>
					{rotation ? (
						<Badge variant={rotation.complete && rotation.raced === 0 ? "success" : "warning"}>
							{rotation.complete
								? t("operator.encryption.complete", "Verified")
								: t("operator.encryption.incomplete", "Resume required")}
						</Badge>
					) : null}
				</div>
				<div className="mt-5 grid gap-4 md:grid-cols-2">
					<div className="flex flex-col gap-3">
						<Input
							label={t("operator.encryption.publisherDid", "Publisher DID")}
							value={publisherDid}
							onChange={(event) => setPublisherDid(event.currentTarget.value)}
						/>
						<Input
							label={t("operator.encryption.publisherCursor", "Publisher resume cursor")}
							value={publisherRotationCursor}
							onChange={(event) => setPublisherRotationCursor(event.currentTarget.value)}
						/>
						<Button
							disabled={!publisherDid}
							loading={busy}
							onClick={() => rotateEncryption("publisher")}
							variant="outline"
						>
							{t("operator.encryption.publisher", "Rotate publisher shard")}
						</Button>
					</div>
					<div className="flex flex-col gap-3">
						<Input
							label={t("operator.encryption.approverDid", "Approver DID")}
							value={approverDid}
							onChange={(event) => setApproverDid(event.currentTarget.value)}
						/>
						<Input
							label={t("operator.encryption.approverCursor", "Approver resume cursor")}
							value={approverRotationCursor}
							onChange={(event) => setApproverRotationCursor(event.currentTarget.value)}
						/>
						<Button
							disabled={!approverDid}
							loading={busy}
							onClick={() => rotateEncryption("approver")}
							variant="outline"
						>
							{t("operator.encryption.approver", "Rotate approver shard")}
						</Button>
					</div>
				</div>
				{rotation ? (
					<p className="mt-4 text-sm text-kumo-subtle">
						{t(
							"operator.encryption.result",
							"Key {keyVersion}: scanned {scanned}, rotated {rotated}, raced {raced}.",
							{
								keyVersion: rotation.targetKeyVersion,
								scanned: rotation.scanned,
								rotated: rotation.rotated,
								raced: rotation.raced,
							},
						)}
					</p>
				) : null}
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<h2 className="text-xl font-semibold text-kumo-strong">
					{t("operator.publisher.title", "Publisher lookup")}
				</h2>
				<form
					className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end"
					onSubmit={lookupPublisher}
				>
					<Input
						className="flex-1"
						label={t("operator.publisher.did", "Publisher DID")}
						required
						value={publisherDid}
						onChange={(event) => setPublisherDid(event.currentTarget.value)}
					/>
					<Button loading={busy} type="submit" variant="primary">
						{t("operator.publisher.lookup", "Look up publisher")}
					</Button>
				</form>
				{publisher ? (
					<div className="mt-5 flex flex-wrap items-center gap-3 border-t pt-5">
						<Badge variant={publisher.control.status === "allowed" ? "success" : "error"}>
							{operatorStatus(t, publisher.control.status)}
						</Badge>
						<Badge variant={publisher.delegation?.status === "active" ? "success" : "neutral"}>
							{publisher.delegation
								? operatorStatus(t, publisher.delegation.status)
								: t("operator.publisher.noDelegation", "No delegation")}
						</Badge>
						<Button
							loading={busy}
							onClick={() => setSuspended(publisher.control.status !== "suspended")}
							variant="outline"
						>
							{publisher.control.status === "suspended"
								? t("operator.publisher.restore", "Restore")
								: t("operator.publisher.suspend", "Suspend")}
						</Button>
						<Button loading={busy} onClick={revokePublisher} variant="secondary-destructive">
							{t("operator.publisher.revoke", "Revoke authority")}
						</Button>
					</div>
				) : null}
			</Surface>

			<Surface className="rounded-xl border bg-kumo-base p-6">
				<h2 className="text-xl font-semibold text-kumo-strong">
					{t("operator.intent.title", "Intent recovery")}
				</h2>
				<div className="mt-5 grid gap-4 sm:grid-cols-2">
					<Input
						label={t("operator.intent.publisherDid", "Publisher DID")}
						required
						value={publisherDid}
						onChange={(event) => setPublisherDid(event.currentTarget.value)}
					/>
					<Input
						label={t("operator.intent.id", "Intent ID")}
						required
						value={intentId}
						onChange={(event) => setIntentId(event.currentTarget.value)}
					/>
				</div>
				<div className="mt-4 flex flex-wrap gap-2">
					<Button
						disabled={!publisherDid || !intentId}
						loading={busy}
						onClick={() => operateIntent("reconcile")}
						variant="primary"
					>
						{t("operator.intent.reconcile", "Reconcile")}
					</Button>
					<Button
						disabled={!publisherDid || !intentId}
						loading={busy}
						onClick={() => operateIntent("cancel")}
						variant="secondary-destructive"
					>
						{t("operator.intent.cancel", "Cancel intent")}
					</Button>
				</div>
			</Surface>
		</div>
	);
}
