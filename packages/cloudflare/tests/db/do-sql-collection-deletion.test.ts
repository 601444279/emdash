import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;

		constructor(ctx: unknown) {
			this.ctx = ctx;
		}
	},
}));

import { EmDashDB } from "../../src/db/do-sql-class.js";

interface FakeCursor {
	rowsWritten: number;
	toArray(): Record<string, unknown>[];
	[Symbol.iterator](): Iterator<Record<string, unknown>>;
}

function cursor(rows: Record<string, unknown>[] = [], rowsWritten = 0): FakeCursor {
	return {
		rowsWritten,
		toArray: () => rows,
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	};
}

describe("EmDashDB collection deletion guard", () => {
	let statements: string[];
	let transactionSync: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		statements = [];
		transactionSync = vi.fn((operation: () => unknown) => operation());
	});

	it("returns stale before dispatching DDL when the exact lease is absent", async () => {
		const sql = {
			exec: vi.fn((statement: string) => {
				statements.push(statement);
				return cursor();
			}),
		};
		const object = new EmDashDB({ storage: { sql, transactionSync } } as never, {});

		await expect(
			object.executeCollectionDeletionGuard({
				action: "drop",
				collectionId: "collection-1",
				collectionSlug: "articles",
				leaseToken: "stale-owner",
			}),
		).resolves.toEqual({ outcome: "stale" });

		expect(transactionSync).toHaveBeenCalledOnce();
		expect(statements).toHaveLength(1);
		expect(statements[0]).toContain("SELECT collection_id");
		expect(statements.some((statement) => statement.includes("DROP TABLE"))).toBe(false);
	});

	it("executes the exact drop inside one synchronous primary transaction", async () => {
		const sql = {
			exec: vi.fn((statement: string) => {
				statements.push(statement);
				return statement.includes("SELECT collection_id")
					? cursor([{ collection_id: "collection-1" }])
					: cursor();
			}),
		};
		const object = new EmDashDB({ storage: { sql, transactionSync } } as never, {});

		await expect(
			object.executeCollectionDeletionGuard({
				action: "drop",
				collectionId: "collection-1",
				collectionSlug: "articles",
				leaseToken: "current-owner",
			}),
		).resolves.toEqual({ outcome: "dropped" });

		expect(transactionSync).toHaveBeenCalledOnce();
		expect(statements.filter((statement) => statement.includes("DROP TRIGGER"))).toHaveLength(3);
		expect(statements.filter((statement) => statement.includes("DROP TABLE"))).toHaveLength(2);
	});

	it("preserves non-forced content and fences the collection once empty", async () => {
		let contentPresent = true;
		const sql = {
			exec: vi.fn((statement: string) => {
				statements.push(statement);
				if (statement.includes("SELECT collection_id")) {
					return cursor([{ collection_id: "collection-1" }]);
				}
				if (statement.includes("SELECT 1 AS present")) {
					return cursor(contentPresent ? [{ present: 1 }] : []);
				}
				if (statement.includes("UPDATE _emdash_media_usage_index_status")) {
					return cursor([], 1);
				}
				return cursor();
			}),
		};
		const object = new EmDashDB({ storage: { sql, transactionSync } } as never, {});
		const input = {
			action: "fence" as const,
			collectionId: "collection-1",
			collectionSlug: "articles",
			leaseToken: "current-owner",
			forceDelete: false,
		};

		await expect(object.executeCollectionDeletionGuard(input)).resolves.toEqual({
			outcome: "has_content",
		});
		expect(statements.some((statement) => statement.includes("UPDATE _emdash"))).toBe(false);

		statements = [];
		contentPresent = false;
		await expect(object.executeCollectionDeletionGuard(input)).resolves.toEqual({
			outcome: "fenced",
		});
		expect(statements.some((statement) => statement.includes("UPDATE _emdash"))).toBe(true);
	});
});
