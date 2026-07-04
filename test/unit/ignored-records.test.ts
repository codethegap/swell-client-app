import { describe, expect, it, vi } from "vitest";
import { persistIgnoredRecords } from "../../functions/utils/ignored-records";

describe("persistIgnoredRecords", () => {
  it("writes ignored records through deterministic upserts outside the file record", async () => {
    const post = vi.fn(async (url: string, ops: any[]) => {
      expect(url).toBe("/:batch");
      return Object.fromEntries(ops.map((_op, i) => [String(i), { id: `ok_${i}` }]));
    });

    await persistIgnoredRecords(
      { post } as any,
      {
        importId: "import_1",
        fileId: "507f1f77bcf86cd799439011",
        page: 7,
        records: [
          { name: "Bad row", slug: "bad-row", error: "No product" },
          { name: "Other row", error: "No category", details: { category: "missing" } },
        ],
      },
    );

    const ops = post.mock.calls[0][1];
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      method: "put",
      data: {
        import_id: "import_1",
        file_id: "507f1f77bcf86cd799439011",
        page: 7,
        slug: "bad-row",
        error: "No product",
      },
    });
    expect(ops[0].url).toMatch(/^\/ignored-records\/[0-9a-f]{24}$/);
    expect(ops[1].data.details).toBe(JSON.stringify({ category: "missing" }));
  });
});
