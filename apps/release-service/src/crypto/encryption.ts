const LEGACY_ENVELOPE_VERSION = 1;
const ENVELOPE_VERSION = 2;
const ASSOCIATED_DATA_VERSION = 1;
const ENCRYPTION_ALGORITHM = "A256GCM";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_ENVELOPE_CHARS = 1_500_000;
const MAX_KEYRING_CHARS = 64 * 1024;
const MAX_KEYRING_KEYS = 32;
const MAX_KEY_VERSION = 2_147_483_647;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const TABLE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;
const OBJECT_CLASS_PATTERN = /^[A-Z][A-Za-z0-9]{0,127}$/;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_PADDING_PATTERN = /=+$/;
const OWNED_PURPOSES: ReadonlySet<unknown> = new Set<OwnedEncryptionPurpose>([
	"oauth-session",
	"dpop-private-key",
	"email-address",
	"webhook-destination",
	"webhook-secret",
	"csrf-secret",
]);
const UNOWNED_PURPOSES: ReadonlySet<unknown> = new Set<UnownedEncryptionPurpose>([
	"confidential-client-private-key",
]);
const OPTIONAL_OWNER_PURPOSES: ReadonlySet<unknown> = new Set<OptionalOwnerEncryptionPurpose>([
	"oauth-transaction",
	"oauth-console-transaction",
	"oauth-approver-transaction",
	"oauth-delegation-transaction",
]);

export type OwnedEncryptionPurpose =
	| "oauth-session"
	| "dpop-private-key"
	| "email-address"
	| "webhook-destination"
	| "webhook-secret"
	| "csrf-secret";

export type OptionalOwnerEncryptionPurpose =
	| "oauth-transaction"
	| "oauth-console-transaction"
	| "oauth-approver-transaction"
	| "oauth-delegation-transaction";

export type UnownedEncryptionPurpose = "confidential-client-private-key";

export type EncryptionPurpose =
	| OwnedEncryptionPurpose
	| OptionalOwnerEncryptionPurpose
	| UnownedEncryptionPurpose;

interface EncryptionContextBase {
	objectClass: string;
	table: string;
	primaryKey: string;
}

export type EncryptionContext = EncryptionContextBase &
	(
		| { purpose: OwnedEncryptionPurpose; ownerDid: string }
		| { purpose: OptionalOwnerEncryptionPurpose; ownerDid: string | null }
		| { purpose: UnownedEncryptionPurpose; ownerDid: null }
	);

export interface EncryptedValue {
	envelope: string;
	keyVersion: number;
}

export type EncryptionErrorCode =
	| "ENCRYPTION_CONFIGURATION_INVALID"
	| "ENCRYPTION_CONTEXT_INVALID"
	| "ENCRYPTED_VALUE_INVALID"
	| "ENCRYPTED_VALUE_UNSUPPORTED"
	| "ENCRYPTION_KEY_UNAVAILABLE"
	| "ENCRYPTION_FAILED"
	| "DECRYPTION_FAILED";

const ERROR_MESSAGES: Record<EncryptionErrorCode, string> = {
	ENCRYPTION_CONFIGURATION_INVALID: "Invalid encryption configuration",
	ENCRYPTION_CONTEXT_INVALID: "Invalid encryption context",
	ENCRYPTED_VALUE_INVALID: "Invalid encrypted value",
	ENCRYPTED_VALUE_UNSUPPORTED: "Unsupported encrypted value",
	ENCRYPTION_KEY_UNAVAILABLE: "Encryption key is unavailable",
	ENCRYPTION_FAILED: "Encryption failed",
	DECRYPTION_FAILED: "Decryption failed",
};

export class EncryptionError extends Error {
	readonly code: EncryptionErrorCode;

	constructor(code: EncryptionErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "EncryptionError";
		this.code = code;
	}
}

interface EncryptionKeyring {
	currentVersion: number;
	keys: ReadonlyMap<number, Uint8Array<ArrayBuffer>>;
}

interface LegacySerializedEnvelope {
	v: typeof LEGACY_ENVELOPE_VERSION;
	k: number;
	n: string;
	c: string;
}

interface SerializedEnvelope {
	v: typeof ENVELOPE_VERSION;
	a: typeof ENCRYPTION_ALGORITHM;
	d: typeof ASSOCIATED_DATA_VERSION;
	k: number;
	n: string;
	c: string;
}

type ParsedEnvelope = LegacySerializedEnvelope | SerializedEnvelope;

export interface EnvelopeEncryption {
	readonly currentKeyVersion: number;
	encrypt(plaintext: Uint8Array, context: EncryptionContext): Promise<EncryptedValue>;
	decrypt(envelope: string, context: EncryptionContext): Promise<Uint8Array<ArrayBuffer>>;
	needsRotation(envelope: string): boolean;
	rotate(envelope: string, context: EncryptionContext): Promise<EncryptedValue>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(record);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isKeyVersion(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_KEY_VERSION;
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 32 * 1024;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(BASE64_PADDING_PATTERN, "");
}

function decodeBase64Url(value: unknown): Uint8Array<ArrayBuffer> | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!BASE64URL_PATTERN.test(value) ||
		value.length % 4 === 1
	) {
		return null;
	}
	try {
		const padded = value
			.replaceAll("-", "+")
			.replaceAll("_", "/")
			.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return encodeBase64Url(bytes) === value ? bytes : null;
	} catch {
		return null;
	}
}

function invalidConfiguration(): never {
	throw new EncryptionError("ENCRYPTION_CONFIGURATION_INVALID");
}

function parseKeyring(value: string): EncryptionKeyring {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEYRING_CHARS) {
		invalidConfiguration();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		invalidConfiguration();
	}
	if (!isRecord(parsed) || !hasExactKeys(parsed, ["current", "keys"])) {
		invalidConfiguration();
	}
	const current = parsed["current"];
	const entries = parsed["keys"];
	if (
		!isKeyVersion(current) ||
		!Array.isArray(entries) ||
		entries.length === 0 ||
		entries.length > MAX_KEYRING_KEYS
	) {
		invalidConfiguration();
	}
	const keys = new Map<number, Uint8Array<ArrayBuffer>>();
	for (const entry of entries) {
		if (!isRecord(entry) || !hasExactKeys(entry, ["version", "key"])) {
			invalidConfiguration();
		}
		const version = entry["version"];
		const key = decodeBase64Url(entry["key"]);
		if (!isKeyVersion(version) || !key || key.length !== 32 || keys.has(version)) {
			invalidConfiguration();
		}
		keys.set(version, key);
	}
	if (!keys.has(current)) invalidConfiguration();
	return { currentVersion: current, keys };
}

function parseEnvelope(value: string): ParsedEnvelope {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENVELOPE_CHARS) {
		throw new EncryptionError("ENCRYPTED_VALUE_INVALID");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new EncryptionError("ENCRYPTED_VALUE_INVALID");
	}
	if (!isRecord(parsed)) {
		throw new EncryptionError("ENCRYPTED_VALUE_INVALID");
	}
	const version = parsed["v"];
	if (version !== LEGACY_ENVELOPE_VERSION && version !== ENVELOPE_VERSION) {
		throw new EncryptionError("ENCRYPTED_VALUE_UNSUPPORTED");
	}
	const expectedKeys =
		version === LEGACY_ENVELOPE_VERSION ? ["v", "k", "n", "c"] : ["v", "a", "d", "k", "n", "c"];
	if (!hasExactKeys(parsed, expectedKeys)) {
		throw new EncryptionError("ENCRYPTED_VALUE_INVALID");
	}
	if (
		version === ENVELOPE_VERSION &&
		(parsed["a"] !== ENCRYPTION_ALGORITHM || parsed["d"] !== ASSOCIATED_DATA_VERSION)
	) {
		throw new EncryptionError("ENCRYPTED_VALUE_UNSUPPORTED");
	}
	const keyVersion = parsed["k"];
	const encodedNonce = parsed["n"];
	const encodedCiphertext = parsed["c"];
	const nonce = decodeBase64Url(encodedNonce);
	const ciphertext = decodeBase64Url(encodedCiphertext);
	if (
		!isKeyVersion(keyVersion) ||
		typeof encodedNonce !== "string" ||
		typeof encodedCiphertext !== "string" ||
		!nonce ||
		nonce.length !== NONCE_BYTES ||
		!ciphertext ||
		ciphertext.length < TAG_BYTES ||
		ciphertext.length > MAX_PLAINTEXT_BYTES + TAG_BYTES
	) {
		throw new EncryptionError("ENCRYPTED_VALUE_INVALID");
	}
	const envelope: ParsedEnvelope =
		version === LEGACY_ENVELOPE_VERSION
			? { v: LEGACY_ENVELOPE_VERSION, k: keyVersion, n: encodedNonce, c: encodedCiphertext }
			: {
					v: ENVELOPE_VERSION,
					a: ENCRYPTION_ALGORITHM,
					d: ASSOCIATED_DATA_VERSION,
					k: keyVersion,
					n: encodedNonce,
					c: encodedCiphertext,
				};
	if (JSON.stringify(envelope) !== value) {
		throw new EncryptionError("ENCRYPTED_VALUE_INVALID");
	}
	return envelope;
}

function snapshotContext(context: EncryptionContext): EncryptionContext {
	if (
		!isRecord(context) ||
		!hasExactKeys(context, ["purpose", "objectClass", "table", "primaryKey", "ownerDid"])
	) {
		throw new EncryptionError("ENCRYPTION_CONTEXT_INVALID");
	}
	const purpose = context["purpose"];
	const hasOwnedPurpose = OWNED_PURPOSES.has(purpose);
	const hasUnownedPurpose = UNOWNED_PURPOSES.has(purpose);
	const hasOptionalOwnerPurpose = OPTIONAL_OWNER_PURPOSES.has(purpose);
	const hasValidDid =
		typeof context.ownerDid === "string" &&
		context.ownerDid.length <= 2048 &&
		DID_PATTERN.test(context.ownerDid);
	if (
		(!hasOwnedPurpose && !hasUnownedPurpose && !hasOptionalOwnerPurpose) ||
		typeof context.objectClass !== "string" ||
		!OBJECT_CLASS_PATTERN.test(context.objectClass) ||
		typeof context.table !== "string" ||
		!TABLE_PATTERN.test(context.table) ||
		typeof context.primaryKey !== "string" ||
		context.primaryKey.length === 0 ||
		context.primaryKey.length > 512 ||
		(hasOwnedPurpose && !hasValidDid) ||
		(hasUnownedPurpose && context.ownerDid !== null) ||
		(hasOptionalOwnerPurpose && context.ownerDid !== null && !hasValidDid)
	) {
		throw new EncryptionError("ENCRYPTION_CONTEXT_INVALID");
	}
	return { ...context };
}

function encodeInfo(
	version: ParsedEnvelope["v"],
	keyVersion: number,
	purpose: EncryptionPurpose,
	deploymentId: string,
): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(
		new TextEncoder().encode(
			version === LEGACY_ENVELOPE_VERSION
				? JSON.stringify(["emdash-release-service", "data-key", version, keyVersion, purpose])
				: JSON.stringify([
						"emdash-release-service",
						"data-key",
						version,
						ENCRYPTION_ALGORITHM,
						ASSOCIATED_DATA_VERSION,
						deploymentId,
						keyVersion,
						purpose,
					]),
		),
	);
}

function encodeAdditionalData(
	version: ParsedEnvelope["v"],
	keyVersion: number,
	context: EncryptionContext,
	deploymentId: string,
): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(
		new TextEncoder().encode(
			version === LEGACY_ENVELOPE_VERSION
				? JSON.stringify([
						"emdash-release-service",
						"ciphertext",
						version,
						keyVersion,
						context.purpose,
						context.table,
						context.primaryKey,
						context.ownerDid,
					])
				: JSON.stringify([
						"emdash-release-service",
						"ciphertext",
						version,
						ENCRYPTION_ALGORITHM,
						ASSOCIATED_DATA_VERSION,
						deploymentId,
						context.objectClass,
						keyVersion,
						context.purpose,
						context.table,
						context.primaryKey,
						context.ownerDid,
					]),
		),
	);
}

function encodeHkdfSalt(version: ParsedEnvelope["v"]): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(
		new TextEncoder().encode(JSON.stringify(["emdash-release-service", "hkdf-salt", version])),
	);
}

class WebCryptoEnvelopeEncryption implements EnvelopeEncryption {
	readonly currentKeyVersion: number;
	readonly #keys: ReadonlyMap<number, Uint8Array<ArrayBuffer>>;
	readonly #derivedKeys = new Map<string, Promise<CryptoKey>>();
	readonly #deploymentId: string;

	constructor(keyring: EncryptionKeyring, deploymentId: string) {
		if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
			throw new EncryptionError("ENCRYPTION_CONFIGURATION_INVALID");
		}
		this.currentKeyVersion = keyring.currentVersion;
		this.#keys = keyring.keys;
		this.#deploymentId = deploymentId;
	}

	async #deriveKey(
		version: ParsedEnvelope["v"],
		keyVersion: number,
		purpose: EncryptionPurpose,
	): Promise<CryptoKey> {
		const cacheKey = `${version}:${keyVersion}:${purpose}`;
		let derived = this.#derivedKeys.get(cacheKey);
		if (!derived) {
			const masterKey = this.#keys.get(keyVersion);
			if (!masterKey) throw new EncryptionError("ENCRYPTION_KEY_UNAVAILABLE");
			derived = crypto.subtle
				.importKey("raw", masterKey, "HKDF", false, ["deriveKey"])
				.then((key) =>
					crypto.subtle.deriveKey(
						{
							name: "HKDF",
							hash: "SHA-256",
							salt: encodeHkdfSalt(version),
							info: encodeInfo(version, keyVersion, purpose, this.#deploymentId),
						},
						key,
						{ name: "AES-GCM", length: 256 },
						false,
						["encrypt", "decrypt"],
					),
				);
			this.#derivedKeys.set(cacheKey, derived);
		}
		return derived;
	}

	async encrypt(plaintext: Uint8Array, context: EncryptionContext): Promise<EncryptedValue> {
		const contextSnapshot = snapshotContext(context);
		if (!(plaintext instanceof Uint8Array) || plaintext.length > MAX_PLAINTEXT_BYTES) {
			throw new EncryptionError("ENCRYPTION_FAILED");
		}
		const keyVersion = this.currentKeyVersion;
		const plaintextCopy = Uint8Array.from(plaintext);
		try {
			const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
			const key = await this.#deriveKey(ENVELOPE_VERSION, keyVersion, contextSnapshot.purpose);
			const encrypted = await crypto.subtle.encrypt(
				{
					name: "AES-GCM",
					iv: nonce,
					additionalData: encodeAdditionalData(
						ENVELOPE_VERSION,
						keyVersion,
						contextSnapshot,
						this.#deploymentId,
					),
					tagLength: 128,
				},
				key,
				plaintextCopy,
			);
			const envelope = JSON.stringify({
				v: ENVELOPE_VERSION,
				a: ENCRYPTION_ALGORITHM,
				d: ASSOCIATED_DATA_VERSION,
				k: keyVersion,
				n: encodeBase64Url(nonce),
				c: encodeBase64Url(new Uint8Array(encrypted)),
			});
			return { envelope, keyVersion };
		} catch {
			throw new EncryptionError("ENCRYPTION_FAILED");
		}
	}

	async decrypt(envelope: string, context: EncryptionContext): Promise<Uint8Array<ArrayBuffer>> {
		const contextSnapshot = snapshotContext(context);
		const parsed = parseEnvelope(envelope);
		if (!this.#keys.has(parsed.k)) {
			throw new EncryptionError("ENCRYPTION_KEY_UNAVAILABLE");
		}
		try {
			const key = await this.#deriveKey(parsed.v, parsed.k, contextSnapshot.purpose);
			const decrypted = await crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: decodeBase64Url(parsed.n)!,
					additionalData: encodeAdditionalData(
						parsed.v,
						parsed.k,
						contextSnapshot,
						this.#deploymentId,
					),
					tagLength: 128,
				},
				key,
				decodeBase64Url(parsed.c)!,
			);
			return new Uint8Array(decrypted);
		} catch {
			throw new EncryptionError("DECRYPTION_FAILED");
		}
	}

	needsRotation(envelope: string): boolean {
		const parsed = parseEnvelope(envelope);
		return parsed.v !== ENVELOPE_VERSION || parsed.k !== this.currentKeyVersion;
	}

	async rotate(envelope: string, context: EncryptionContext): Promise<EncryptedValue> {
		const contextSnapshot = snapshotContext(context);
		const parsed = parseEnvelope(envelope);
		const plaintext = await this.decrypt(envelope, contextSnapshot);
		if (parsed.v === ENVELOPE_VERSION && parsed.k === this.currentKeyVersion) {
			return { envelope, keyVersion: parsed.k };
		}
		return this.encrypt(plaintext, contextSnapshot);
	}
}

export function createEnvelopeEncryption(
	keyring: string,
	deploymentId: string,
): EnvelopeEncryption {
	return new WebCryptoEnvelopeEncryption(parseKeyring(keyring), deploymentId);
}
